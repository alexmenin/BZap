// WebSocketClient.ts - Módulo responsável pela conexão WebSocket com WhatsApp Web

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { Agent } from 'https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { makeNoiseHandler } from './NoiseHandler';
import { QRCodeGenerator } from '../utils/QRCodeGenerator';
import { waproto } from '@wppconnect/wa-proto';
import { createAuthPayload, SocketConfig } from '../utils/PayloadGenerator';
import { AuthenticationState, AuthenticationCreds } from '../auth/AuthStateManager';
import { configureSuccessfulPairing, getBinaryNodeChild, generateRegistrationNode } from '../utils/ValidateConnection';
import { uploadPreKeysToServerIfRequired } from '../utils/PreKeyManager';
import { encodeBinaryNode } from '../protocol/WABinary/encode';
import { binaryNodeToString } from '../protocol/WABinary/decode';
import { MessageDecryption } from '../crypto/MessageDecryption';
import { SignalProtocolStore } from '../crypto/SignalProtocolStore';
import { createSignalProtocolAddress } from '../utils/SignalUtils';
const libsignal = require('libsignal');


import {
  WA_SOCKET_URL,
  DEFAULT_ORIGIN,
  NOISE_CONFIG,
  CONNECTION_CONFIG,
  WS_CLOSE_CODES,
  WS_CLIENT_CONFIG
} from '../constants/Constants';

/**
 * Constantes do protocolo WhatsApp Web baseadas no Baileys
 * Agora importadas do arquivo Constants.ts centralizado
 */
const WA_WS_URL = WA_SOCKET_URL;
const WA_ORIGIN = DEFAULT_ORIGIN;
const WA_MAGIC_VALUE = NOISE_CONFIG.magicValue;
const WA_DICT_VERSION = NOISE_CONFIG.dictVersion;
const WA_CONN_HEADER = NOISE_CONFIG.waHeader;

// Usar constantes centralizadas
const DEFAULT_CONNECTION_TIMEOUT = WS_CLIENT_CONFIG.DEFAULT_CONNECTION_TIMEOUT;
const DEFAULT_RESPONSE_TIMEOUT = WS_CLIENT_CONFIG.DEFAULT_RESPONSE_TIMEOUT;
const KEEPALIVE_INTERVAL = WS_CLIENT_CONFIG.KEEPALIVE_INTERVAL;
const MAX_RECONNECT_ATTEMPTS = WS_CLIENT_CONFIG.MAX_RECONNECT_ATTEMPTS;
const RECONNECT_BASE_DELAY = WS_CLIENT_CONFIG.RECONNECT_BASE_DELAY;
const QR_TIMEOUT = WS_CLIENT_CONFIG.QR_TIMEOUT;
const HANDSHAKE_TIMEOUT = WS_CLIENT_CONFIG.HANDSHAKE_TIMEOUT;

/**
 * Interface para configuração de proxy
 */
export interface ProxyConfig {
  enabled: boolean;
  type: 'http' | 'https' | 'socks4' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/**
 * Interface para eventos do WebSocket (compatível com Baileys)
 */
export interface WebSocketEvents {
  'connected': () => void;
  'disconnected': (code: number, reason: string) => void;
  'message': (data: Buffer) => void;
  'error': (error: Error) => void;
  'connection.update': (update: ConnectionUpdate) => void;
  'creds.update': (creds: Partial<AuthenticationCreds>) => void;
}

/**
 * Interface para atualizações de conexão (compatível com Baileys)
 */
export interface ConnectionUpdate {
  connection?: 'connecting' | 'open' | 'close';
  lastDisconnect?: {
    error?: Error;
    date?: Date;
  };
  qr?: string;
  qrRefs?: string[]; // Lista de referências QR para ciclo
  isNewLogin?: boolean;
  isOnline?: boolean;
  receivedPendingNotifications?: boolean;
}

/**
 * Cliente WebSocket para conexão com WhatsApp Web
 */
export class WebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  public isConnected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS;
  private reconnectDelay = RECONNECT_BASE_DELAY;
  private noiseHandler: any;
  private instanceId?: string;
  private keepAliveInterval?: NodeJS.Timeout;
  private connectionTimeout?: NodeJS.Timeout;
  private httpsAgent: Agent;
  private headerSent = false; // Flag para controlar envio do header WA
  private proxyConfig?: ProxyConfig;
  private authState?: AuthenticationState; // Estado de autenticação Baileys
  private saveCreds?: () => Promise<void>; // Função para salvar credenciais
  private lastDateRecv?: Date; // Última data de recebimento de dados (como no Baileys)
  private lastMessageReceived: Date = new Date(); // Timestamp da última mensagem recebida
  private qrTimer?: NodeJS.Timeout; // Timer para QR codes
  private qrTimeout = 60000; // Timeout padrão para QR codes
  private qrRefs?: any[]; // Referências QR recebidas do pair-device
  private qrCredentials?: { // Credenciais para geração de QR codes
    noiseKeyB64: string;
    identityKeyB64: string;
    advB64: string;
  };
  private streamEnded = false; // Flag para evitar processamento repetido de xmlstreamend
  private connectionClosed = false; // Flag para evitar múltiplas emissões de eventos 'close'
  private lastCloseReason?: string; // Armazena o último motivo de fechamento para evitar duplicatas
  private _serverEventsSetup = false; // ✅ Flag para evitar handlers duplicados
  private passiveIqSent = false; // ✅ Flag para evitar passive IQ duplicado
  private prekeySyncInFlight = false; // ✅ Flag para evitar upload duplicado de pre-keys
  private _successHandled = false; // ✅ Flag para evitar múltiplos processamentos do evento success
  private _pairSuccessHandled = false; // ✅ Flag para controlar se pair-success foi processado

  // ✅ CORREÇÃO 2: Upload de pre-keys com lock para evitar concorrência/duplicidade
  private async uploadPreKeysToServerIfRequired(): Promise<void> {
    if (this.prekeySyncInFlight) {
      return;
    }

    this.prekeySyncInFlight = true;

    try {
      if (!this.authState) {
        console.warn('⚠️ AuthState não disponível para upload de pre-keys');
        return;
      }

      // Chama a função utilitária com os parâmetros corretos
      await uploadPreKeysToServerIfRequired(this.authState, this.sendNode.bind(this));

    } catch (error) {
      console.error('❌ Erro no upload de pre-keys:', error);
    } finally {
      this.prekeySyncInFlight = false;
    }
  }

  // ✅ CORREÇÃO 4: Corrigir transição de status no connection.update
  private handleConnectionUpdate(update: Partial<ConnectionUpdate>): void {
    console.log('🔄 Connection update:', update);

    // ✅ CORREÇÃO: Só marcar connected quando connection === 'open'
    if (update.connection === 'open') {
      this.emit('connection.update', {
        connection: 'connected',
        receivedPendingNotifications: false
      });
      console.log('✅ Conexão estabelecida com sucesso');
      return;
    }

    // Para QR code, emitir apenas quando update.qr vier
    if (update.qr) {
      this.emit('connection.update', {
        connection: 'connecting',
        qr: update.qr,
        receivedPendingNotifications: false
      });
      return;
    }

    // Para outros estados, emitir conforme recebido
    this.emit('connection.update', update);
  }

  constructor(proxyConfig?: ProxyConfig, authState?: AuthenticationState, saveCreds?: () => Promise<void>, instanceId?: string) {
    super();
    this.noiseHandler = null;
    this.proxyConfig = proxyConfig;
    this.authState = authState;
    this.saveCreds = saveCreds;
    this.instanceId = instanceId;
    this.httpsAgent = this.createAgent();
  }

  /**
   * Helper unificado para responder pings (normal e dentro de stream:error)
   * Seguindo EXATAMENTE o padrão Baileys oficial
   */
  private async respondToPing(pingLike: any): Promise<void> {
    try {
      const id = pingLike?.attrs?.id ?? pingLike?.attrs?.t;
      if (!id) {
        console.warn('⚠️ Ping sem id/t; não é possível responder.');
        return;
      }

      const pong: any = {
        tag: 'iq',
        attrs: {
          to: 's.whatsapp.net',
          type: 'result',
          id
        }
      };

      await this.sendNode(pong);
      this.lastMessageReceived = new Date();
      console.log('✅ Pong enviado (id=%s) para s.whatsapp.net', id);
    } catch (err: any) {
      console.error('❌ Falha ao enviar pong:', err?.message ?? err);
    }
  }


  /**
   * Cria agent HTTP/HTTPS com suporte a proxy
   */
  private createAgent(): Agent {
    if (this.proxyConfig?.enabled) {
      const proxyUrl = this.buildProxyUrl();
      console.log(`🌐 Configurando proxy: ${this.proxyConfig.type}://${this.proxyConfig.host}:${this.proxyConfig.port}`);

      switch (this.proxyConfig.type) {
        case 'http':
        case 'https':
          return new HttpsProxyAgent(proxyUrl);
        case 'socks4':
        case 'socks5':
          return new SocksProxyAgent(proxyUrl);
        default:
          throw new Error(`Tipo de proxy não suportado: ${this.proxyConfig.type}`);
      }
    }

    // Agent padrão sem proxy
    return new Agent({
      keepAlive: true,
      keepAliveMsecs: KEEPALIVE_INTERVAL,
      maxSockets: 1,
      maxFreeSockets: 1,
      timeout: DEFAULT_CONNECTION_TIMEOUT
    });
  }

  /**
   * Constrói URL do proxy
   */
  private buildProxyUrl(): string {
    const { type, host, port, username, password } = this.proxyConfig!;
    const auth = username && password ? `${username}:${password}@` : '';
    return `${type}://${auth}${host}:${port}`;
  }

  /**
   * Valida a conexão seguindo exatamente o fluxo do Baileys
   * 1. Envia ClientHello com chave efêmera
   * 2. Recebe resposta do servidor WhatsApp
   * 3. Processa handshake com protocolo Noise
   * 4. Envia ClientFinish com payload criptografado
   * 5. Finaliza inicialização (noise.finishInit())
   */
  private async validateConnection(): Promise<void> {
    try {
      console.log('🤝 Iniciando handshake...');

      // Verifica se o estado de autenticação foi fornecido
      if (!this.authState) {
        throw new Error('Estado de autenticação Baileys não fornecido para o handshake');
      }

      // Initialize NoiseHandler
      this.noiseHandler = makeNoiseHandler({
        keyPair: {
          public: Buffer.from(this.authState.creds.pairingEphemeralKeyPair.public),
          private: Buffer.from(this.authState.creds.pairingEphemeralKeyPair.private)
        },
        NOISE_HEADER: WA_CONN_HEADER,
        logger: console as any,
        authState: this.authState,
        instanceId: this.instanceId
      });

      // 1. Envia ClientHello com chave efêmera (seguindo padrão Baileys)
      let helloMsg: waproto.IHandshakeMessage = {
        clientHello: { ephemeral: this.authState.creds.pairingEphemeralKeyPair.public }
      };
      helloMsg = waproto.HandshakeMessage.create(helloMsg);

      console.log('📤 Enviando ClientHello...');
      const init = waproto.HandshakeMessage.encode(helloMsg).finish();
      this.sendFrame(Buffer.from(init));

      // 2. Aguarda resposta do servidor (ServerHello)
      const serverResponseBuffer = await this.awaitNextMessage(HANDSHAKE_TIMEOUT);

      // 3. Decodifica ServerHello usando protobuf (seguindo padrão Baileys)
      const handshake = waproto.HandshakeMessage.decode(serverResponseBuffer);
      console.log('📥 ServerHello recebido');

      // 4. Processa handshake com protocolo Noise
      const keyEnc = await this.noiseHandler.processHandshake(handshake, this.authState.creds.noiseKey);
      if (!keyEnc) {
        throw new Error('Falha ao processar resposta do servidor');
      }

      // 5. Gera o payload de autenticação correto (login ou registro) - seguindo padrão Baileys
      console.log('📤 Criando ClientFinish com ClientPayload...');

      // Configuração do socket baseada nas credenciais (padrão Baileys)
      const socketConfig: SocketConfig = {
        browser: ['Chrome', 'Desktop', '131.0.0.0'],
        version: [2, 3000, 1023223821],
        syncFullHistory: false,
        countryCode: 'BR'
      };

      let node: waproto.IClientPayload;
      if (!this.authState.creds.me || !this.authState.creds.registered) {
        // Para registro, usar generateRegistrationNode do Baileys
        const signalCreds = {
          registrationId: this.authState.creds.registrationId,
          signedPreKey: this.authState.creds.signedPreKey,
          signedIdentityKey: this.authState.creds.signedIdentityKey
        };
        node = generateRegistrationNode(signalCreds, socketConfig);
        console.log('✅ Payload de registro gerado (generateRegistrationNode)');
      } else {
        // Para login, usar generateLoginNode do Baileys (apenas se registered === true)
        const { generateLoginNode } = require('../utils/ValidateConnection');
        node = generateLoginNode(this.authState.creds.me.id, socketConfig);
        console.log('✅ Payload de login gerado (generateLoginNode) - registered:', this.authState.creds.registered);
      }

      // 6. Criptografa e envia ClientFinish (seguindo padrão Baileys)
      const payloadEnc = this.noiseHandler.encrypt(waproto.ClientPayload.encode(node).finish());
      const clientFinishBuffer = waproto.HandshakeMessage.encode({
        clientFinish: {
          static: keyEnc,
          payload: payloadEnc
        }
      }).finish();

      console.log('📤 Enviando ClientFinish...');
      this.sendFrame(Buffer.from(clientFinishBuffer));

      // 7. Finaliza inicialização (noise.finishInit()) - seguindo padrão Baileys original
      this.noiseHandler.finishInit();
      console.log('✅ Protocolo Noise inicializado - handshake concluído');

      console.log('🎉 Handshake concluído - aguardando pair-device do servidor');

    } catch (error) {
      console.error('❌ Erro na validação da conexão:', error);
      throw error;
    }
  }

  /**
   * Aguarda próxima mensagem do WebSocket
   */
  private async awaitNextMessage(timeout: number = DEFAULT_RESPONSE_TIMEOUT): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.removeListener('frame', frameHandler);
        reject(new Error(`Timeout aguardando resposta do servidor (${timeout}ms)`));
      }, timeout);

      const frameHandler = (frame: Buffer) => {
        clearTimeout(timeoutId);
        this.removeListener('frame', frameHandler);
        resolve(frame);
      };

      this.once('frame', frameHandler);
    });
  }

  /**
   * Configura listeners para eventos do servidor
   */
  private setupServerEventListeners(): void {
    // Listener para frames decodificados - seguindo EXATAMENTE o padrão Baileys oficial
    this.on('frame', (frame: any) => {
      try {
        if (this.noiseHandler && this.noiseHandler.isFinished()) {
          // Após handshake: processa frames decodificados
          this.processDecodedFrame(frame);
        }
      } catch (error) {
        // Erro ao processar frame - silencioso para evitar spam
      }
    });
  }

  /**
   * Processa frame decodificado e emite eventos apropriados
   */
  private async processDecodedFrame(frame: any): Promise<void> {
    try {
      let anyTriggered = false;

      // Se é um binary node (não Uint8Array)
      if (!(frame instanceof Uint8Array)) {
        const msgId = frame.attrs?.id;
        const frameTag = frame.tag;

        // Emite evento por ID da mensagem (padrão Baileys)
        if (msgId) {
          anyTriggered = this.emit(`TAG:${msgId}`, frame) || anyTriggered;
        }

        // Emite eventos por callback pattern (padrão Baileys oficial)
        const l0 = frameTag;
        const l1 = frame.attrs || {};
        const l2 = Array.isArray(frame.content) ? frame.content[0]?.tag : '';

        // Padrão Baileys: CB:tag,attr:value,content
        for (const key of Object.keys(l1)) {
          const eventName1 = `CB:${l0},${key}:${l1[key]},${l2}`;
          const eventName2 = `CB:${l0},${key}:${l1[key]}`;
          const eventName3 = `CB:${l0},${key}`;

          anyTriggered = this.emit(eventName1, frame) || anyTriggered;
          anyTriggered = this.emit(eventName2, frame) || anyTriggered;
          anyTriggered = this.emit(eventName3, frame) || anyTriggered;
        }

        const eventName4 = `CB:${l0},,${l2}`;
        const eventName5 = `CB:${l0}`;

        anyTriggered = this.emit(eventName4, frame) || anyTriggered;
        anyTriggered = this.emit(eventName5, frame) || anyTriggered;
      }
    } catch (error) {
      // Erro ao processar frame decodificado - silencioso para evitar spam
    }
  }

  /**
   * Busca um nó filho específico (equivalente ao getBinaryNodeChild do Baileys)
   */
  private getBinaryNodeChild(node: any, childTag: string): any {
    if (!node || !node.content || !Array.isArray(node.content)) {
      return null;
    }

    return node.content.find((child: any) => child && child.tag === childTag);
  }

  /**
   * Busca todos os nós filhos com uma tag específica (equivalente ao getBinaryNodeChildren do Baileys)
   */
  private getBinaryNodeChildren(node: any, childTag: string): any[] {
    if (!node || !node.content || !Array.isArray(node.content)) {
      return [];
    }

    return node.content.filter((child: any) => child && child.tag === childTag);
  }

  /**
   * Codifica frame seguindo exatamente o padrão Baileys
   */
  private encodeFrame(data: Buffer): Buffer {
    // Se o handshake não estiver finalizado, os dados são enviados sem criptografia
    // (no Baileys, isFinished controla se deve criptografar)

    const header = Buffer.from(WA_CONN_HEADER);
    const introSize = this.headerSent ? 0 : header.length;
    const frame = Buffer.alloc(introSize + 3 + data.length);

    if (!this.headerSent) {
      frame.set(header);
      this.headerSent = true;
      // Frame enviado - log removido para evitar spam
    }

    // Tamanho em 3 bytes (big-endian) - exatamente como no Baileys
    frame.writeUInt8(data.length >> 16, introSize);
    frame.writeUInt16BE(65535 & data.length, introSize + 1);
    frame.set(data, introSize + 3);

    return frame;
  }

  /**
   * Envia frame de dados usando o padrão Baileys
   */
  private sendFrame(data: Buffer): void {
    if (!this.isConnected || !this.ws) {
      throw new Error('WebSocket não está conectado');
    }

    const frame = this.encodeFrame(data);

    // Log dos dados enviados
    this.logBinaryData('SEND', frame);

    this.ws.send(frame);
  }

  /**
   * Conecta ao servidor WhatsApp Web
   */
  public async connect(): Promise<void> {
    if (this.isConnected) {
      throw new Error('WebSocket já está conectado');
    }

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      console.log('🔌 Conectando ao WhatsApp Web...');
      console.log(`📍 URL: ${WA_WS_URL}`);
      console.log(`🌐 Proxy: ${this.proxyConfig?.enabled ? `${this.proxyConfig.type}://${this.proxyConfig.host}:${this.proxyConfig.port}` : 'Não configurado'}`);
      console.log(`⏱️ Timeout: ${DEFAULT_CONNECTION_TIMEOUT}ms`);

      // Reset do flag do header para nova conexão
      this.headerSent = false;

      // Reset das flags de controle de eventos para nova conexão
      this.streamEnded = false;
      this.connectionClosed = false;
      this.lastCloseReason = undefined;

      // Timeout de conexão
      this.connectionTimeout = setTimeout(() => {
        if (this.ws) {
          this.ws.terminate();
        }
        reject(new Error('Timeout na conexão WebSocket'));
      }, DEFAULT_CONNECTION_TIMEOUT);

      this.ws = new WebSocket(WA_WS_URL, {
        origin: WA_ORIGIN,
        agent: this.httpsAgent,
        handshakeTimeout: DEFAULT_CONNECTION_TIMEOUT,
        timeout: DEFAULT_CONNECTION_TIMEOUT,
        headers: {} // Usar headers vazios como no Baileys original
      });

      this.ws.on('open', async () => {
        const connectionTime = Date.now() - startTime;
        console.log(`✅ Conexão WebSocket estabelecida em ${connectionTime}ms`);
        console.log(`🔗 URL: ${WA_WS_URL}`);
        console.log(`🌐 Proxy: ${this.proxyConfig?.enabled ? 'Habilitado' : 'Desabilitado'}`);
        console.log(`🔄 Tentativa: ${this.reconnectAttempts + 1}`);

        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = undefined;
        }

        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.lastDateRecv = new Date(); // Inicializa timestamp de recebimento

        // Configura os listeners ANTES do handshake para capturar pair-device
        console.log('🔧 [SETUP] Configurando setupServerEventListeners...');
        this.setupServerEventListeners();
        console.log('🔧 [SETUP] setupServerEventListeners configurado com sucesso');

        // Inicia o processo de validação da conexão (handshake) IMEDIATAMENTE
        // seguindo exatamente o fluxo do Baileys original
        try {
          await this.validateConnection();
          console.log('🤝 Handshake inicial concluído - aguardando eventos do servidor...');

          // Após o handshake, configura os handlers Baileys e keep-alive
          console.log('🔧 [SETUP] Configurando setupBaileysEventHandlers...');
          this.setupBaileysEventHandlers();
          console.log('🔧 [SETUP] setupBaileysEventHandlers configurado com sucesso');

          this.startKeepAlive();

          // Se já está registrado e handshake finalizado, reenvia presença + passive IQ
          // para garantir ativação do canal mesmo quando CB:success não é emitido
          try {
            if (this.authState?.creds?.registered && this.noiseHandler?.isFinished()) {
              console.log('📡 Reenviando presença e passive IQ após conexão (registered)');
              await this.sendNode({
                tag: 'presence',
                attrs: { name: 'desktop', type: 'available' }
              });
              await this.maybeSendPassiveActive();
              console.log('✅ Canal de mensagens reativado (pós-conexão)');
            }
          } catch (err) {
            console.warn('⚠️ Falha ao reativar canal pós-conexão:', err);
          }

          // NÃO emitir 'connected' aqui - será emitido quando receber success ou pair-device
          resolve();

        } catch (error) {
          console.error('❌ Erro na validação da conexão:', error);
          this.emit('error', error);
          reject(error);
          return;
        }
      });

      this.ws.on('message', (data: Buffer) => {
        this.lastDateRecv = new Date(); // Atualiza timestamp sempre que recebe dados
        // console.log(`📨 Dados recebidos: ${data.length} bytes`);
        // this.logBinaryData('RECV', data);

        // Processa dados através do NoiseHandler seguindo padrão Baileys-master
        // dentro do decodeFrame callback
        this.noiseHandler.decodeFrame(data, async (frame: Buffer | any) => {
          // log apenas do XML de mensagens descriptografadas (sem dados criptografados)
          if ((frame as any)?.tag && (frame as any)?.tag !== 'message') {
            try {
              const xmlString = binaryNodeToString(frame as any)
              // console.log('📋 XML DECODIFICADO:')
              // console.log(xmlString)
            } catch { }
          }

          // ✅ emita o evento 'frame' AQUI
          this.emit('frame', frame)

          // ❌ não chame processDecodedFrame diretamente aqui
          // await this.processDecodedFrame(frame)  <-- remova
        })
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason.toString();

        // ✅ CORREÇÃO: Ajustar log para código 1006 após pair-success (fluxo normal)
        if (code === 1006 && this.authState?.creds?.me?.id) {
          console.log(`ℹ️ Reconexão esperada após pair-success - Código: ${code}`);
          console.log(`🔄 WhatsApp fechou a sessão antiga para permitir reconexão autenticada`);
        } else {
          console.log(`❌ Conexão fechada - Código: ${code}, Motivo: ${reasonStr}`);
          console.log(`🔍 Detalhes do fechamento:`);
          console.log(`   - Código: ${code} (${this.getCloseCodeDescription(code)})`);
          console.log(`   - Motivo: ${reasonStr || 'Não especificado'}`);
        }

        console.log(`   - Tentativas de reconexão: ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
        console.log(`   - Proxy habilitado: ${this.proxyConfig?.enabled ? 'Sim' : 'Não'}`);

        this.cleanup();
        this.emit('disconnected', code, reasonStr);

        // Auto-reconexão para códigos específicos
        if (this.shouldReconnect(code)) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error: Error) => {
        console.error('❌ Erro no WebSocket:', error.message);

        // Tratamento específico para erro de conflito (múltiplas conexões)
        if (error.message.includes('Stream Errored (conflict)') || error.message.includes('conflict')) {
          console.log('⚠️ Detectado erro de conflito - aguardando antes de reconectar...');
          // Aguarda mais tempo antes de tentar reconectar para evitar conflitos
          setTimeout(() => {
            this.cleanup();
            this.emit('error', new Error('Connection conflict detected - retrying with delay'));
          }, 5000); // 5 segundos de delay
          return;
        }

        this.cleanup();
        this.emit('error', error);
        reject(error);
      });

      // Remove listeners de ping/pong nativos do WebSocket que causam reconexões
      // O Baileys usa IQ messages para keep-alive, não ping/pong nativo
    });
  }

  /**
   * Envia dados binários pelo WebSocket
   */
  public send(data: Buffer): void {
    if (!this.isConnected || !this.ws) {
      throw new Error('WebSocket não está conectado');
    }

    // console.log(`📤 Enviando dados: ${data.length} bytes`);
    this.logBinaryData('SEND', data);
    this.ws.send(data);
  }

  /**
   * Serializa e envia um nó XMPP (alto nível) - seguindo padrão Baileys
   */
  public async sendNode(node: any): Promise<void> {
    // console.log('📤 Enviando nó binário:', {
    //   tag: node.tag,
    //   attrs: node.attrs,
    //   hasContent: !!node.content
    // });

    // Codifica o nó binário usando encoder oficial do WABinary (função assíncrona)
    const encoded = await encodeBinaryNode(node);
    // console.log('DEBUG PONG XML:', binaryNodeToString(node));
    // console.log('DEBUG PONG HEX:', encoded.toString('hex'));
    return this.sendBinaryNode(encoded);
  }

  /**
   * Envia bytes já codificados via Noise/WebSocket (baixo nível) - seguindo padrão Baileys
   */
  private async sendBinaryNode(data: Buffer): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('❌ Tentativa de envio com WebSocket não conectado:', {
        wsExists: !!this.ws,
        readyState: this.ws?.readyState,
        expectedState: WebSocket.OPEN
      });
      throw new Error('WebSocket não está conectado');
    }

    try {
      let frame: Buffer;

      // Separação correta: NoiseHandler faz apenas criptografia, WebSocketClient faz framing
      if (this.noiseHandler && this.noiseHandler.isFinished()) {
        // console.log('🔐 Criptografando dados através do NoiseHandler...');
        const encrypted = this.noiseHandler.encrypt(data); // apenas criptografia
        frame = this.encodeFrame(encrypted); // framing (header + length prefix) feito aqui
      } else {
        // Sem NoiseHandler ou handshake não finalizado, usa framing direto
        frame = this.encodeFrame(data);
      }

      // console.log('📤 Enviando frame binário:', {
      //   originalSize: data.length,
      //   encodedSize: frame.length,
      //   hasNoiseHandler: !!this.noiseHandler,
      //   isHandshakeFinished: this.noiseHandler?.isFinished()
      // });

      this.ws.send(frame);
      // this.logBinaryData('SEND', frame);
      // console.log('✅ Frame enviado com sucesso');

    } catch (error: any) {
      console.error('❌ Erro ao enviar dados binários:', {
        error: error.message,
        stack: error.stack,
        wsReadyState: this.ws?.readyState,
        dataSize: data.length
      });
      throw error;
    }
  }

  /**
   * Configura handlers de eventos específicos do Baileys
   */
  private setupBaileysEventHandlers(): void {
    // ✅ CORREÇÃO 1: Evitar registrar handlers duplicados
    if (this._serverEventsSetup) return;
    this._serverEventsSetup = true;

    console.log('🎧 Configurando handlers de eventos Baileys...');

    // Emite connection.update inicial seguindo padrão Baileys (process.nextTick equivalente)
    process.nextTick(() => {
      this.emit('connection.update', {
        connection: 'connecting',
        receivedPendingNotifications: false,
        qr: undefined
      });
    });

    // ✅ CORREÇÃO: Usar apenas um registrador amplo para IQ e filtrar dentro
    this.on('CB:iq', async (node: any) => {
      if (node?.tag !== 'iq') return;

      // ✅ trata ping mesmo sem content
      if (node.attrs.type === 'get' && node.attrs.xmlns === 'urn:xmpp:ping') {
        await this.respondToPing(node);
        return;
      }

      const child = node.content?.[0];
      if (!child) return;

      if (node.attrs.type === 'set' && child.tag === 'pair-device') {
        await this.handlePairDevice(node);
        return;
      }

      if (node.attrs.type === 'set' && child.tag === 'pair-success') {
        await this.handlePairSuccess(node);
        return;
      }
    });

    this.on('CB:stream:error', async (node: any) => {
      // IMPORTANTE: Verificar se é erro relacionado a ping mal formado
      const reasonNode = node.content?.[0];
      if (reasonNode?.tag === 'ping') {
        console.warn('⚠️ Stream error (ping) recebido - ignorando como faz o Baileys');

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.close(1000, 'pong malformed');
        }
        return;
      }

      // Para outros tipos de stream:error, logar normalmente
      console.error('❌ Stream errored out:', node);

      // Seguindo EXATAMENTE o padrão Baileys original
      const { reason, statusCode } = this.getErrorCodeFromStreamError(node);

      // Cria erro no formato Boom (padrão Baileys)
      const streamError = new Error(`Stream Errored (${reason})`);
      (streamError as any).output = { statusCode, data: node };

      // Evita emitir múltiplos eventos 'close' para o mesmo erro de stream
      const streamErrorMessage = `Stream Errored (${reason})`;
      if (!this.connectionClosed || this.lastCloseReason !== streamErrorMessage) {
        this.connectionClosed = true;
        this.lastCloseReason = streamErrorMessage;

        this.emit('connection.update', {
          connection: 'close',
          lastDisconnect: {
            error: streamError,
            date: new Date()
          }
        });
      }

      // Fecha a conexão adequadamente (seguindo padrão Baileys)
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, streamErrorMessage);
      }
    });

    this.on('CB:xmlstreamend', () => {
      // Evita processamento repetido do xmlstreamend
      if (this.streamEnded) {
        return;
      }

      this.streamEnded = true;

      // Seguindo padrão Baileys oficial: emite connection.update com connectionClosed
      // Evita emitir múltiplos eventos 'close' para xmlstreamend
      const xmlStreamEndMessage = 'Connection Terminated by Server';
      if (!this.connectionClosed || this.lastCloseReason !== xmlStreamEndMessage) {
        this.connectionClosed = true;
        this.lastCloseReason = xmlStreamEndMessage;

        this.emit('connection.update', {
          connection: 'close',
          lastDisconnect: {
            error: new Error(xmlStreamEndMessage),
            date: new Date()
          }
        });
      }

      // Fecha a conexão WebSocket adequadamente
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Stream ended by server');
      }
    });

    // Success handler - processa nó 'success' do servidor (padrão Baileys)
    this.on('CB:success', async (node: any) => {
      try {
        // ✅ CORREÇÃO 2: Upload de pre-keys com lock para evitar duplicação
        await this.uploadPreKeysToServerIfRequired();

        // ✅ CORREÇÃO 3: Envia passive IQ 'active' com debounce
        await this.maybeSendPassiveActive();

      } catch (err: any) {
        console.warn('⚠️ Falha ao enviar passive IQ inicial:', err);
      }

      await this.handleConnectionSuccess(node);
    });

    // Connection failures
    this.on('CB:failure', (node: any) => {
      this.handleConnectionFailure(node);
    });

    // Handler para notificações (notification)
    this.on('CB:notification', async (stanza: any) => {
      try {
        console.debug('🔔 Notificação recebida:', stanza.attrs?.type);

        // Emite evento de notificação
        this.emit('messages.upsert', {
          messages: [stanza],
          type: 'notify'
        });

        // ✅ Ack de HISTORY_SYNC_NOTIFICATION e patches para liberar fluxo de mensagens
        const hasChild = (tag: string) => {
          return Array.isArray(stanza.content) && stanza.content.some((c: any) => c?.tag === tag);
        };

        const shouldAckHistSync =
          hasChild('sync') ||
          hasChild('hist_sync') ||
          hasChild('history') ||
          hasChild('app_state_sync_key_share');

        if (shouldAckHistSync) {
          const receiptNode = {
            tag: 'receipt',
            attrs: {
              to: 's.whatsapp.net',
              type: 'hist_sync',
              id: stanza?.attrs?.id ?? this.generateMessageTag()
            }
          };
          console.debug('📩 Enviando receipt de hist_sync');
          await this.sendNode(receiptNode);
        }

        // Ack para patches de app state (patch/patches)
        if (hasChild('patch') || hasChild('patches')) {
          const receiptPatch = {
            tag: 'receipt',
            attrs: {
              to: 's.whatsapp.net',
              type: 'patch',
              id: stanza?.attrs?.id ?? this.generateMessageTag()
            }
          };
          console.debug('📩 Enviando receipt de patch');
          await this.sendNode(receiptPatch);
        }

      } catch (error) {
        console.error('❌ Erro ao processar notificação:', error);
      }
    });

    // Handler para receipts (confirmações de entrega)
    this.on('CB:receipt', async (stanza: any) => {
      try {
        console.log('✅ Receipt recebido:', stanza.attrs?.type);

        // Emite evento de receipt
        this.emit('messages.update', [stanza]);

      } catch (error) {
        console.error('❌ Erro ao processar receipt:', error);
      }
    });

    // ✅ Handler para mensagens (CB:message) - seguindo padrão Baileys
    this.on('CB:message', async (stanza: any) => {
      try {
        // Emite mensagem no formato Baileys
        this.emit('messages.upsert', {
          messages: [stanza],
          type: 'notify'
        });

      } catch (error) {
        console.error('❌ Erro ao processar mensagem:', error);
      }
    });
  }

  /**
   * Processa sucesso da conexão seguindo padrão Baileys
   */
  private async handleConnectionSuccess(node: any): Promise<void> {
    // ✅ CORREÇÃO: Evitar múltiplos processamentos do evento success
    if (this._successHandled) {
      return;
    }

    // ✅ CORREÇÃO RECONEXÃO: Se já registrado, aceitar success sem pair-success
    if (this.authState?.creds?.registered) {
      console.log('✅ Sessão já registrada - usando success como conexão válida');
      console.log('🔄 Reconexão com credenciais salvas detectada');
    } else {
      // ✅ NOVA CORREÇÃO: Só processar CB:success após pair-success real para primeiro login
      // Verifica se já houve um pair-success válido antes de processar o success
      if (!this._pairSuccessHandled) {
        console.log('⚠️ CB:success recebido antes do pair-success - ignorando');
        console.log('🔍 Aguardando pair-success real antes de processar connection:open');
        return;
      }
    }

    this._successHandled = true;
    console.log('✅ Conexão estabelecida com sucesso após pair-success válido:', node);

    try {
      // Upload de pre-keys e passive IQ serão feitos no evento CB:success
      // após o handshake estar completamente finalizado

      console.log('🌐 Conexão aberta para WhatsApp');

      // ✅ CORREÇÃO: Garantir persistência imediata após success
      if (this.authState?.creds) {
        this.authState.creds.registered = true;

        // ✅ NOVA CORREÇÃO: Importar companion_enc_static do nó success para reconexões
        if (node.attrs?.companion_enc_static && this.authState.creds) {
          console.log('🔑 Importando companion_enc_static do success para authState');
          this.authState.creds.companionKey = Buffer.from(node.attrs.companion_enc_static, 'base64');
          console.log('✅ companion_enc_static importado com sucesso');
        }

        // Salva as credenciais imediatamente
        if (this.saveCreds) {
          await this.saveCreds();
          console.log('💾 Credenciais salvas após success');
        }
      }

      // Atualiza credenciais com LID se disponível
      if (node.attrs?.lid && this.authState?.creds.me?.id) {
        const updatedCreds = {
          me: { ...this.authState.creds.me, lid: node.attrs.lid }
        };

        Object.assign(this.authState.creds, updatedCreds);
        this.emit('creds.update', updatedCreds);

        // Salva as credenciais se a função estiver disponível
        if (this.saveCreds) {
          await this.saveCreds();
        }
      }

      // ✅ NOVA FUNCIONALIDADE: Criar sessão inicial se necessário (tanto para primeiro login quanto reconexão)
      try {
        console.log('🔍 Verificando se precisa criar sessão inicial...');
        await this.createInitialSession();
      } catch (error) {
        console.warn('⚠️ Erro ao criar sessão inicial:', error);
      }

      // ✅ CORREÇÃO RECONEXÃO: Enviar presence para ativar recepção de mensagens
      if (this.authState?.creds?.registered) {
        console.log('📡 Enviando presença (available) para ativar recepção de mensagens');
        try {
          await this.sendNode({
            tag: 'presence',
            attrs: { name: 'desktop', type: 'available' }
          });
          console.log('✅ Presença enviada - canal de mensagens ativado');
        } catch (error) {
          console.warn('⚠️ Erro ao enviar presença:', error);
        }
      }

      // Emite evento connection.update seguindo padrão Baileys
      this.emit('connection.update', { connection: 'open' });
      console.log('✅ [WebSocketClient] Login concluído');

    } catch (error: any) {
      console.warn('⚠️ Erro no processamento do success:', error);
      // Mesmo com erro, consideramos a conexão aberta
      console.log('📡 Conexão aberta (com avisos)');
      this.emit('connection.update', { connection: 'open' });
    }
  }

  /**
   * Processa evento pair-device seguindo exatamente o padrão Baileys oficial
   */
  private async handlePairDevice(stanza: any): Promise<void> {
    const iq = {
      tag: 'iq',
      attrs: { to: 's.whatsapp.net', type: 'result', id: stanza.attrs.id }
    };
    await this.sendNode(iq);

    const pairDeviceNode = this.getBinaryNodeChild(stanza, 'pair-device');
    const refNodes = this.getBinaryNodeChildren(pairDeviceNode, 'ref');
    this.qrRefs = refNodes.map(n => (n.content as Buffer).toString('utf-8'));

    const noiseKeyB64 = Buffer.from(this.authState!.creds.noiseKey.public).toString('base64');
    const identityKeyB64 = Buffer.from(this.authState!.creds.signedIdentityKey.public).toString('base64');
    const advB64 = this.authState!.creds.advSecretKey;

    // Gera lista de QRs para o ciclo (novo formato)
    const qrList = this.qrRefs.map(ref => [ref, noiseKeyB64, identityKeyB64, advB64].join(','));
    
    console.log(`📱 Enviando ${qrList.length} QR codes para ciclo`);

    // Emite evento com lista de QRs para o ciclo
    this.emit('connection.update', {
      connection: 'connecting',
      qrRefs: qrList,
      isNewLogin: true
    });

    console.log(`🔄 Ciclo de QR iniciado com ${qrList.length} referências`);
  }

  // ✅ CORREÇÃO 5: Garantir que QR seja parado exatamente uma vez após pair-success
  private qrGenerationStopped = false;

  private stopQRGeneration(): void {
    if (this.qrGenerationStopped) {
      console.log('⚠️ QR generation já foi parado - evitando duplicação');
      return;
    }

    this.qrGenerationStopped = true;
    console.log('🔍 [DEBUG] stopQRGeneration chamado');

    // ✅ Limpa as referências QR para impedir reutilização
    this.qrRefs = [];
    console.log('🔍 [DEBUG] qrRefs limpo - não haverá mais QR codes');

    if (this.qrTimer) {
      console.log(`🔍 [DEBUG] Limpando timer QR: ${this.qrTimer}`);
      clearTimeout(this.qrTimer);
      this.qrTimer = undefined;
      console.log('🔍 [DEBUG] Timer QR limpo');
    } else {
      console.log('🔍 [DEBUG] Nenhum timer QR para limpar');
    }
    console.log('⏹️ Geração de QR codes interrompida');
  }

  /**
   * Processa evento de pareamento bem-sucedido (pair-success) seguindo padrão Baileys
   */
  private async handlePairSuccess(stanza: any): Promise<void> {
    try {
      console.log('🎉 Pair-success recebido - processando seguindo padrão Baileys');

      // ✅ NOVA CORREÇÃO: Marca que pair-success foi processado
      this._pairSuccessHandled = true;

      // Para o timer de QR code imediatamente (como no Baileys oficial)
      this.stopQRGeneration();

      // Usa configureSuccessfulPairing do Baileys para processar o pareamento
      const { configureSuccessfulPairing } = require('../utils/ValidateConnection');
      const { reply, creds: updatedCreds } = configureSuccessfulPairing(stanza, this.authState!.creds);

      console.log('✅ Pareamento configurado com sucesso');
      console.log('📱 Me:', updatedCreds.me);
      console.log('🖥️ Platform:', updatedCreds.platform);

      // ✅ CORREÇÃO: Extrair dados específicos do pair-success
      const deviceNode = stanza.content?.find((child: any) => child.tag === 'device');
      const deviceJid = updatedCreds.me?.id;
      const bizName = updatedCreds.me?.name;
      const lid = updatedCreds.me?.lid;
      const platform = deviceNode?.attrs?.name || 'smba';

      // ✅ Atualizar campos obrigatórios após pair-success com dados corretos
      this.authState!.creds.me = {
        id: deviceJid || this.authState!.creds.me?.id || '',
        name: bizName || this.authState!.creds.me?.name,
        lid: lid || this.authState!.creds.me?.lid
      };

      // ✅ Marcar como registrado
      this.authState!.creds.registered = true;

      // ✅ Salvar a platform
      this.authState!.creds.platform = platform;

      // ✅ Atualizar signalIdentities para o novo device (limpar identidades antigas)
      if (deviceJid) {
        // Inicializar signalIdentities se não existir
        if (!this.authState!.creds.signalIdentities) {
          this.authState!.creds.signalIdentities = [];
        }

        // Limpar identidades antigas de outros devices
        const oldDeviceIds = this.authState!.creds.signalIdentities
          .filter(identity => identity.identifier.name !== deviceJid)
          .map(identity => identity.identifier.name);

        if (oldDeviceIds.length > 0) {
          console.log(`🧹 Limpando identidades antigas de devices: ${oldDeviceIds.join(', ')}`);
          this.authState!.creds.signalIdentities = this.authState!.creds.signalIdentities
            .filter(identity => identity.identifier.name === deviceJid);
        }

        // Garantir que existe signalIdentity para o device atual
        const existingIdentity = this.authState!.creds.signalIdentities
          .find(identity => identity.identifier.name === deviceJid);

        if (!existingIdentity) {
          this.authState!.creds.signalIdentities.push({
            identifier: { name: deviceJid, deviceId: 0 },
            identifierKey: this.authState!.creds.signedIdentityKey.public
          });
          console.log(`🔑 Criada signalIdentity para device: ${deviceJid}`);
        }
      }

      // ✅ Atualizar outros campos obrigatórios
      this.authState!.creds.lastAccountSyncTimestamp = Date.now();
      this.authState!.creds.account = this.authState!.creds.account || {
        details: "",
        accountSignatureKey: "",
        accountSignature: "",
        deviceSignature: ""
      };

      // ✅ Aplicar todas as atualizações das credenciais
      this.authState!.creds = { ...this.authState!.creds, ...updatedCreds };

      // ✅ Salvar imediatamente após todas as atualizações
      if (this.saveCreds) {
        await this.saveCreds();
      }
      
      // ✅ CORREÇÃO: Persistir signalIdentities no SignalProtocolStore
      try {
        // Cria SignalProtocolStore usando o authState atual
        const signalStore = new SignalProtocolStore(
          this.authState!.keys,
          {
            pubKey: this.authState!.creds.signedIdentityKey.public,
            privKey: this.authState!.creds.signedIdentityKey.private
          },
          this.authState!.creds.registrationId,
          this.authState!.creds,
          this.instanceId, // Garantir que instanceId é passado
          this.authState // Passar authState para permitir persistência
        );
        
        // Persistir a identidade local no banco para evitar Bad MAC
        if (deviceJid) {
          const addressInfo = createSignalProtocolAddress(deviceJid);
          await signalStore.storeIdentity(
            addressInfo,
            Buffer.from(this.authState!.creds.signedIdentityKey.public)
          );
          console.log(`💾 Identidade local persistida no banco para: ${deviceJid}`);
        }
      } catch (error) {
        console.error('❌ Erro ao persistir identidade no SignalProtocolStore:', error);
      }
      
      console.log('💾 Credenciais salvas após pair-success com dados completos');
      console.log(`📱 Device ID: ${this.authState!.creds.me?.id}`);
      console.log(`🆔 LID: ${this.authState!.creds.me?.lid}`);
      console.log(`✅ Registered: ${this.authState!.creds.registered}`);
      console.log(`🖥️ Platform: ${this.authState!.creds.platform}`);

      // ✅ Upload das Pre-Keys com lock para evitar duplicidade
      await this.uploadPreKeysToServerIfRequired();

      // ✅ NOVA FUNCIONALIDADE: Criar sessão inicial após pareamento bem-sucedido
      await this.createInitialSession();

      // ✅ CORREÇÃO: Emite apenas creds.update no pair-success (padrão Baileys)
      this.emit('creds.update', this.authState!.creds);

      // Envia resposta para o servidor (padrão Baileys)
      await this.sendNode(reply);
      console.log('✅ Resposta de pair-success enviada');

      // ✅ Enviar passive IQ <active/> apenas uma vez
      if (!this.passiveIqSent) {
        try {
          await this.sendNode({
            tag: 'iq',
            attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'passive' },
            content: [{ tag: 'active', attrs: {} }]
          });
          this.passiveIqSent = true;
          console.log('📡 Passive IQ <active/> enviado após pair-success (primeira vez)');
        } catch (error) {
          console.error('❌ Erro ao enviar passive IQ:', error);
        }
      }

      // ✅ CORREÇÃO: Remove QR do estado mas NÃO emite connection.update:open aqui
      // O connection.update:open será emitido apenas no CB:success
      this.emit('connection.update', {
        connection: 'connecting',
        qr: undefined,
        isNewLogin: true
      });

      console.log('✅ Pair-success processado - aguardando CB:success para connection:open');

    } catch (error) {
      console.error('❌ Erro ao processar pair-success:', error);
      this.emit('connection.update', {
        connection: 'close',
        lastDisconnect: {
          error: error instanceof Error ? error : new Error(String(error)),
          date: new Date()
        }
      });
    }
  }

  /**
   * Cria sessão inicial após pareamento bem-sucedido
   * Necessário para que as mensagens possam ser descriptografadas
   */
  private async createInitialSession(): Promise<void> {
    try {
      if (!this.authState?.creds?.me?.id) {
        console.log('⚠️ Não é possível criar sessão inicial - me.id não disponível');
        return;
      }

      const deviceJid = this.authState.creds.me.id;
      console.log(`🔐 Criando sessão inicial para device: ${deviceJid}`);

      // Cria SignalProtocolStore usando o authState atual
      const signalStore = new SignalProtocolStore(
        this.authState.keys,
        {
          pubKey: this.authState.creds.signedIdentityKey.public,
          privKey: this.authState.creds.signedIdentityKey.private
        },
        this.authState.creds.registrationId,
        this.authState.creds,
        this.instanceId // Adicionando instanceId para permitir persistência no Prisma
      );

      // Cria endereço do protocolo Signal usando a função helper do projeto
      const addressInfo = createSignalProtocolAddress(deviceJid);
      const address = new libsignal.ProtocolAddress(addressInfo.name, addressInfo.deviceId);

      // Verifica se já existe uma sessão
      const hasExistingSession = await signalStore.containsSession(addressInfo);
      if (hasExistingSession) {
        console.log(`✅ Sessão já existe para ${deviceJid}.${addressInfo.deviceId}`);
        return;
      }

      // Não criar sessões manualmente: o libsignal/WhatsApp irá criar e salvar
      // automaticamente a primeira vez que uma mensagem for recebida.
      // Apenas registre que a sessão será criada on-demand.
      console.log(`ℹ️ Nenhuma sessão existente para ${deviceJid}.${addressInfo.deviceId} ainda. Será criada automaticamente ao receber a primeira mensagem.`);

      // Se houver companion_enc_static nas credenciais, atualize o storage
      if (this.authState.creds.companionKey) {
        signalStore.updateCompanionKey(this.authState.creds.companionKey);
      }

    } catch (error) {
      console.error('❌ Erro ao criar sessão inicial:', error);
      // Não falha o pareamento se não conseguir criar a sessão inicial
      // A sessão será criada automaticamente na primeira mensagem recebida
    }
  }

  /**
   * Extrai código de erro de stream:error seguindo padrão Baileys
   */
  private getErrorCodeFromStreamError(node: any): { reason: string; statusCode: number } {
    const child = node?.content?.[0];
    if (!child) return { reason: 'unknown', statusCode: 500 };

    const tag = child.tag as string;

    // Mapeamento básico alinhado ao que o Baileys faz
    switch (tag) {
      case 'conflict': return { reason: 'conflict', statusCode: 409 };
      case 'shutdown': return { reason: 'shutdown', statusCode: 503 };
      case 'replaced': return { reason: 'replaced', statusCode: 409 };
      case 'system-shutdown': return { reason: 'system-shutdown', statusCode: 515 };
      case 'ping': return { reason: 'ping', statusCode: 200 }; // tratado à parte
      default: return { reason: tag, statusCode: Number(child?.attrs?.code) || 500 };
    }
  }

  /**
   * Processa falhas de conexão
   */
  private handleConnectionFailure(node: any): void {
    console.error('❌ Falha na conexão:', node);
    this.emit('connection-failure', node);
  }

  /**
 * Processa evento MD (Metadata) seguindo padrão Baileys
 * Agora só loga e emite evento, sem responder IQs genéricos
 */
  /**
   * Desconecta do servidor
   */
  public disconnect(): void {
    console.log('🔌 Desconectando...');

    // Para geração de QR codes antes de limpar recursos
    this.stopQRGeneration();

    this.cleanup();

    if (this.ws) {
      this.ws.close(1000, 'Desconexão solicitada pelo cliente');
      this.ws = null;
    }
  }

  /**
   * Limpa recursos e timers
   */
  private cleanup(): void {
    this.isConnected = false;

    // Reset da flag de stream ended para permitir reconexões
    this.streamEnded = false;

    // ✅ Reset da flag de passive IQ para nova conexão
    this.passiveIqSent = false;

    // ✅ CORREÇÃO: Reset flags para permitir nova sessão
    this.qrGenerationStopped = false;
    this.prekeySyncInFlight = false;
    this._serverEventsSetup = false;
    this.connectionClosed = false;
    this.lastCloseReason = undefined;
    this._successHandled = false; // ✅ Reset flag de success para nova sessão
    this._pairSuccessHandled = false; // ✅ Reset flag de pair-success para nova sessão

    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = undefined;
    }

    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = undefined;
    }

    if (this.qrTimer) {
      clearTimeout(this.qrTimer);
      this.qrTimer = undefined;
    }
    console.log('🔍 [DEBUG] cleanup() chamado - preservando timer QR para reconexão');
  }

  /**
   * Inicia keep-alive baseado em IQ messages (como no Baileys-master)
   */
  private startKeepAlive(): void {
    this.keepAliveInterval = setInterval(() => {
      if (!this.lastDateRecv) {
        this.lastDateRecv = new Date();
      }

      const diff = Date.now() - this.lastDateRecv.getTime();

      // Verifica se passou muito tempo sem receber dados
      if (diff > KEEPALIVE_INTERVAL * 2) {
        console.log('❌ Conexão perdida - muito tempo sem receber dados');
        this.cleanup();
        this.emit('connection.update', {
          connection: 'close',
          lastDisconnect: {
            error: new Error('Connection was lost'),
            date: new Date()
          }
        });
      } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendKeepAliveIQ().catch(err => {
          console.log('⚠️ Keep-alive IQ falhou (normal durante handshake):', err.message);
        });
      } else {
        console.log('⚠️ Keep-alive chamado quando WebSocket não está aberto');
      }
    }, KEEPALIVE_INTERVAL);
  }

  /**
   * Envia keep-alive IQ message (baseado no Baileys-master)
   */
  private async sendKeepAliveIQ(): Promise<void> {
    try {
      // Só envia keep-alive se a conexão estiver estabelecida e não há QR ativo
      if (!this.isConnected || !this.noiseHandler) {
        return;
      }

      const keepAliveNode = {
        tag: 'iq',
        attrs: {
          id: this.generateMessageTag(),
          to: 's.whatsapp.net',
          type: 'get',
          xmlns: 'urn:xmpp:ping'
        },
        content: [{ tag: 'ping', attrs: {} }]
      };

      console.log('🏓 Enviando keep-alive IQ...');
      await this.sendNode(keepAliveNode);
    } catch (error) {
      // Não trata como erro crítico durante handshake
      throw error;
    }
  }

  /**
   * Gera tag de mensagem única
   */
  private generateMessageTag(): string {
    return Math.random().toString(36).substring(2, 15);
  }

  /**
   * Verifica se deve reconectar baseado no código de fechamento
   */
  private shouldReconnect(code: number): boolean {
    // Códigos que permitem reconexão automática
    const reconnectableCodes = [1006, 1011, 1012, 1013, 1014];

    // Só reconecta se tem credenciais válidas salvas (usuário já autenticado)
    const hasValidCredentials = !!(this.authState?.creds?.me?.id &&
      this.authState?.creds?.noiseKey &&
      this.authState?.creds?.signedIdentityKey);

    return reconnectableCodes.includes(code) &&
      this.reconnectAttempts < this.maxReconnectAttempts &&
      hasValidCredentials;
  }

  /**
   * Propriedade para controlar o debounce do passive IQ
   */
  private passiveIqSentAt: number = 0;

  /**
   * Envia passive IQ seguindo padrão Baileys
   */
  private async sendPassiveIq(tag: 'passive' | 'active'): Promise<void> {
    // Estrutura conforme recomendação: <iq type="set" to="s.whatsapp.net"><passive><active/></passive></iq>
    const content =
      tag === 'active'
        ? [{ tag: 'passive', attrs: {}, content: [{ tag: 'active', attrs: {} }] }]
        : [{ tag: 'passive', attrs: {} }];

    const node = {
      tag: 'iq',
      attrs: {
        to: 's.whatsapp.net',
        type: 'set'
      },
      content
    };

    console.debug(`📤 Enviando passive IQ: ${tag}`);
    await this.sendNode(node);
  }
  
  /**
   * Envia passive IQ com debounce para evitar múltiplos envios
   */
  private async maybeSendPassiveActive(): Promise<void> {
    const now = Date.now();
    if (now - this.passiveIqSentAt < 5000) {
      console.debug('⏱️ Passive IQ ignorado (debounce ativo)');
      return;
    }
    
    await this.sendPassiveIq('active');
    this.passiveIqSentAt = now;
    console.log('📡 Passive IQ <active/> enviado com debounce');
  }

  /**
   * Obtém o header de conexão do WhatsApp
   */
  public getConnectionHeader(): Buffer {
    return WA_CONN_HEADER;
  }

  /**
   * Agenda uma tentativa de reconexão
   */
  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`🔄 Tentativa de reconexão ${this.reconnectAttempts}/${this.maxReconnectAttempts} em ${delay}ms`);
    console.log(`🔑 Usando credenciais salvas para reconexão automática`);

    setTimeout(async () => {
      try {
        // Reconecta usando as credenciais existentes
        await this.connect();

        console.log(`✅ Reconexão bem-sucedida (tentativa ${this.reconnectAttempts})`);

        // Reativar canal de mensagens imediatamente após reconectar
        // mesmo que o evento 'CB:success' não seja disparado em alguns fluxos
        try {
          if (this.authState?.creds?.registered && this.noiseHandler?.isFinished()) {
            console.log('📡 [Reconnect] Reenviando presença + passive IQ');
            await this.sendNode({
              tag: 'presence',
              attrs: { name: 'desktop', type: 'available' }
            });
            await this.maybeSendPassiveActive();
            console.log('✅ Presença + passive IQ reenviados (reconexão)');
          }
        } catch (err) {
          console.warn('⚠️ Falha ao reenviar presença na reconexão:', err);
        }

        // Reset contador de tentativas após sucesso
        this.reconnectAttempts = 0;

      } catch (error) {
        console.error(`❌ Falha na reconexão (tentativa ${this.reconnectAttempts}):`, error);

        // Se ainda pode tentar reconectar
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          console.log(`⏳ Agendando próxima tentativa de reconexão...`);
          this.scheduleReconnect();
        } else {
          console.error(`❌ Máximo de tentativas de reconexão atingido (${this.maxReconnectAttempts})`);
          this.emit('connection.update', {
            connection: 'close',
            lastDisconnect: {
              error: new Error('Falha na reconexão após múltiplas tentativas'),
              date: new Date()
            }
          });
        }
      }
    }, delay);
  }

  /**
   * Retorna descrição do código de fechamento WebSocket
   */
  private getCloseCodeDescription(code: number): string {
    const descriptions: { [key: number]: string } = {
      1000: 'Normal Closure',
      1001: 'Going Away',
      1002: 'Protocol Error',
      1003: 'Unsupported Data',
      1005: 'No Status Received',
      1006: 'Abnormal Closure',
      1007: 'Invalid frame payload data',
      1008: 'Policy Violation',
      1009: 'Message Too Big',
      1010: 'Mandatory Extension',
      1011: 'Internal Server Error',
      1012: 'Service Restart',
      1013: 'Try Again Later',
      1014: 'Bad Gateway',
      1015: 'TLS Handshake'
    };

    return descriptions[code] || 'Unknown';
  }

  /**
   * Log de dados binários para debug
   */
  private logBinaryData(direction: 'SEND' | 'RECV' | 'FRAME', data: Buffer): void {
    const hex = data.toString('hex').match(/.{1,2}/g)?.join(' ') || '';
    const preview = hex.length > 100 ? hex.substring(0, 100) + '...' : hex;
  }
}