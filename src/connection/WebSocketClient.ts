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
import { configureSuccessfulPairing, getBinaryNodeChild } from '../utils/ValidateConnection';
import { uploadPreKeysToServerIfRequired } from '../utils/PreKeyManager';
import { encodeBinaryNode } from '../protocol/WABinary/encode';
import { binaryNodeToString } from '../protocol/WABinary/decode';
import { QRProcessor } from './QRProcessor';
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
  private keepAliveInterval?: NodeJS.Timeout;
  private connectionTimeout?: NodeJS.Timeout;
  private httpsAgent: Agent;
  private headerSent = false; // Flag para controlar envio do header WA
  private proxyConfig?: ProxyConfig;
  private authState?: AuthenticationState; // Estado de autenticação Baileys
  private saveCreds?: () => Promise<void>; // Função para salvar credenciais
  private qrProcessor?: QRProcessor; // Processador dedicado de QR codes
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

  constructor(proxyConfig?: ProxyConfig, authState?: AuthenticationState, saveCreds?: () => Promise<void>) {
    super();
    this.noiseHandler = null;
    this.proxyConfig = proxyConfig;
    this.authState = authState;
    this.saveCreds = saveCreds;
    
    // Inicializa QRProcessor se temos authState
    if (this.authState) {
      this.qrProcessor = new QRProcessor(this.authState, this.sendNode.bind(this));
      
      // Conecta eventos do QRProcessor
      this.qrProcessor.on('connection.update', (update) => {
        this.emit('connection.update', update);
      });
    } else {
      console.log('❌ [WEBSOCKET_CLIENT] AuthState não disponível - QRProcessor não será inicializado');
    }
    this.httpsAgent = this.createAgent();
  }

  /**
   * Envia resposta pong para um ping recebido
   */
  private async sendPong(pingId: string): Promise<void> {
    try {
      console.log(`🏓 Enviando pong para ping ID: ${pingId}`);
      
      const pongNode = {
        tag: 'iq',
        attrs: {
          type: 'result',
          id: pingId
        }
      };
      
      await this.sendNode(pongNode);
      console.log(`✅ Pong enviado com sucesso para ping ID: ${pingId}`);
    } catch (error) {
      console.error(`❌ Erro ao enviar pong para ping ID ${pingId}:`, error);
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
         logger: console as any
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
      if (!this.authState.creds.me) {
        // Para registro, usar generateRegistrationNode do Baileys
        const { generateRegistrationNode } = require('../utils/ValidateConnection');
        const signalCreds = {
          registrationId: this.authState.creds.registrationId,
          signedPreKey: this.authState.creds.signedPreKey,
          signedIdentityKey: this.authState.creds.signedIdentityKey
        };
        node = generateRegistrationNode(signalCreds, socketConfig);
        console.log('✅ Payload de registro gerado (generateRegistrationNode)');
      } else {
        // Para login, usar generateLoginNode do Baileys
        const { generateLoginNode } = require('../utils/ValidateConnection');
        node = generateLoginNode(this.authState.creds.me.id, socketConfig);
        console.log('✅ Payload de login gerado (generateLoginNode)');
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
      
      // 7. Finaliza inicialização (noise.finishInit()) - seguindo padrão Baileys
      this.noiseHandler.finishInit();
      console.log('✅ Protocolo Noise inicializado - handshake concluído');
      
      console.log('🎉 Handshake concluído - aguardando pair-device do servidor');
      
    } catch (error) {
      console.error('❌ Erro na validação da conexão:', error);
      throw error;
    }
  }

  /**
   * Gera um ID único para mensagens
   */
  private generateMessageId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
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
  private processDecodedFrame(frame: any): void {
    try {
      let anyTriggered = false;
      
      // Emite evento 'frame' primeiro (padrão Baileys)
      anyTriggered = this.emit('frame', frame);
      
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
   * Processa pair-device imediatamente seguindo exatamente o padrão Baileys
   */
  private async processarPairDeviceImediatamente(stanza: any): Promise<void> {
    try {
      console.log('🚀 [PAIR-DEVICE] PROCESSAMENTO DIRETO INICIADO');
      
      // 1. Envia resposta IQ imediatamente (padrão Baileys)
      const iq = {
        tag: 'iq',
        attrs: {
          to: 's.whatsapp.net',
          type: 'result',
          id: stanza.attrs.id
        }
      };
      
      await this.sendNode(iq);
      console.log('✅ [PAIR-DEVICE] Resposta IQ enviada');
      
      // 2. Extrai refs diretamente do stanza (padrão Baileys)
      const pairDeviceNode = this.getBinaryNodeChild(stanza, 'pair-device');
      const refNodes = this.getBinaryNodeChildren(pairDeviceNode, 'ref');
      
      console.log(`🔍 [PAIR-DEVICE] Encontrados ${refNodes.length} refs`);
      
      if (refNodes.length === 0) {
        console.log('❌ [PAIR-DEVICE] Nenhum ref encontrado');
        return;
      }
      
      // 3. Prepara chaves (padrão Baileys)
      const noiseKeyB64 = Buffer.from(this.authState!.creds.noiseKey.public).toString('base64');
      const identityKeyB64 = Buffer.from(this.authState!.creds.signedIdentityKey.public).toString('base64');
      const advB64 = this.authState!.creds.advSecretKey;
      
      // Log removido para evitar spam
      // console.log('🔑 [PAIR-DEVICE] Chaves preparadas');
      
      // 4. Gera QR codes seguindo exatamente o padrão Baileys oficial
      let qrMs = 60_000; // 60 segundos para o primeiro QR
      
      const genPairQR = () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          console.log('⚠️ [PAIR-DEVICE] WebSocket fechado, parando QR');
          return;
        }

        const refNode = refNodes.shift();
        if (!refNode) {
          console.log('❌ [PAIR-DEVICE] Todos os refs utilizados - timeout');
          this.emit('connection.update', { 
            connection: 'close',
            lastDisconnect: {
              error: new Error('QR refs attempts ended'),
              date: new Date()
            }
          });
          return;
        }

        // Extrai ref seguindo padrão Baileys
        const ref = (refNode.content as Buffer).toString('utf-8');
        
        // Constrói QR seguindo formato oficial Baileys
        const qr = [ref, noiseKeyB64, identityKeyB64, advB64].join(',');
        
        console.log('\n🎯 ===== QR CODE GERADO (BAILEYS DIRETO) =====');
        console.log(`📱 QR: ${qr}`);
        console.log(`📏 Tamanho: ${qr.length} caracteres`);
        console.log(`⏰ Expira em: ${qrMs / 1000}s`);
        console.log('🎯 ==========================================\n');
        
        // Emite QR seguindo padrão Baileys
        this.emit('connection.update', { qr });
        
        // Agenda próximo QR
        setTimeout(genPairQR, qrMs);
        qrMs = 20_000; // 20s para próximos QRs
      };
      
      // Inicia geração imediatamente
      genPairQR();
      
    } catch (error) {
      console.error('❌ [PAIR-DEVICE] Erro no processamento:', error);
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
   * Constrói nome do evento seguindo padrão Baileys: CB:tag,attr1:value1,attr2:value2
   */
  private buildEventName(node: any): string {
    let eventName = `CB:${node.tag}`;
    
    if (node.attrs) {
      const attrs = Object.entries(node.attrs)
        .filter(([key, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}:${value}`)
        .join(',');
      
      if (attrs) {
        eventName += `,${attrs}`;
      }
    }
    
    return eventName;
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
        console.log(`📨 Dados recebidos: ${data.length} bytes`);
        this.logBinaryData('RECV', data);
        
        // Processa dados através do NoiseHandler seguindo padrão Baileys-master
        if (this.noiseHandler && this.noiseHandler.decodeFrame) {
          this.noiseHandler.decodeFrame(data, (frame: Buffer) => {
            // Mostra o XML diretamente aqui
            if (frame && typeof frame === 'object' && (frame as any).tag) {
              try {
                const xmlString = binaryNodeToString(frame as any);
                console.log(`📋 XML DECODIFICADO:`);
                console.log(xmlString);
              } catch (error) {
                console.error('❌ Erro ao converter para XML:', error);
              }
            }
            
            this.emit('frame', frame);
          });
        } else {
          // Fallback para dados brutos se NoiseHandler não estiver disponível
          this.emit('message', data);
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason.toString();
        console.log(`❌ Conexão fechada - Código: ${code}, Motivo: ${reasonStr}`);
        console.log(`🔍 Detalhes do fechamento:`);
        console.log(`   - Código: ${code} (${this.getCloseCodeDescription(code)})`);
        console.log(`   - Motivo: ${reasonStr || 'Não especificado'}`);
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
    return this.sendBinaryNode(encoded);
  }

  /**
   * Envia bytes já codificados via Noise/WebSocket (baixo nível) - seguindo padrão Baileys
   */
  private async sendBinaryNode(data: Buffer): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket não está conectado');
    }

    try {
      let frame = data;
      
      // Envia através do NoiseHandler se disponível
      if (this.noiseHandler) {
        frame = this.noiseHandler.encodeFrame(data);
      }
      
      this.ws.send(frame);
      this.logBinaryData('SEND', frame);
      
    } catch (error) {
      console.error('❌ Erro ao enviar dados binários:', error);
      throw error;
    }
  }

  /**
   * Configura handlers de eventos específicos do Baileys
   */
  private setupBaileysEventHandlers(): void {
    console.log('🎧 Configurando handlers de eventos Baileys...');
    
    // Emite connection.update inicial seguindo padrão Baileys (process.nextTick equivalente)
    process.nextTick(() => {
      this.emit('connection.update', {
        connection: 'connecting',
        receivedPendingNotifications: false,
        qr: undefined
      });
    });
    
    // Listeners para eventos específicos do protocolo WhatsApp
    
    // Resposta automática para pings do servidor (keep-alive) - padrão Baileys oficial
    // IMPORTANTE: Pings normais vêm como CB:iq,type:get,xmlns:w:p
    // Pings dentro de stream:error são ERROS e devem encerrar a conexão
    this.on('CB:iq,type:get,xmlns:w:p', async (stanza: any) => {
      try {
        console.log('🏓 Ping keep-alive recebido do servidor, respondendo...');
        
        // Responde com pong (iq result) - padrão Baileys oficial
        const pong = {
          tag: 'iq',
          attrs: {
            to: 's.whatsapp.net',
            type: 'result',
            id: stanza.attrs.id
          },
          content: [{ tag: 'pong', attrs: {} }]
        };
        
        await this.sendNode(pong);
        console.log('✅ Pong enviado com sucesso');
        
        // Atualiza timestamp da última mensagem recebida
        this.lastMessageReceived = new Date();
        
      } catch (error) {
        console.error('❌ Erro ao responder ping keep-alive:', error);
      }
    });
    
    this.on('CB:stream:error', (node: any) => {
      
      // Extrai o motivo do erro seguindo exatamente o padrão Baileys
      const reasonNode = node.content?.[0];
      let reason = reasonNode?.tag || 'unknown';
      const statusCode = +(node.attrs?.code || 500);
      
      
      // Seguindo padrão Baileys oficial: SEMPRE encerra a conexão para qualquer stream:error
      // Evita emitir múltiplos eventos 'close' para o mesmo erro de stream
      const streamErrorMessage = `Stream Errored (${reason})`;
      if (!this.connectionClosed || this.lastCloseReason !== streamErrorMessage) {
        this.connectionClosed = true;
        this.lastCloseReason = streamErrorMessage;
        
        this.emit('connection.update', {
          connection: 'close',
          lastDisconnect: {
            error: new Error(streamErrorMessage),
            date: new Date(),
            output: { statusCode }
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

    this.on('CB:iq,type:set,pair-device', async (stanza: any) => {
      await this.handlePairDevice(stanza);
    });
    
    // Pair device handler - processa solicitação de pareamento no conteúdo
    this.on('CB:iq,,pair-device', async (stanza: any) => {
      await this.handlePairDevice(stanza);
    });
    
    // Pair success handler - processa pareamento bem-sucedido
    this.on('CB:iq,,pair-success', async (stanza: any) => {
      await this.handlePairSuccess(stanza);
    });
    
    // Success handler - processa nó 'success' do servidor (padrão Baileys)
    this.on('CB:success', async (node: any) => {
      try {
        // Upload de pre-keys se necessário (seguindo padrão Baileys)
        if (this.authState) {
          await uploadPreKeysToServerIfRequired(this.authState, this.sendNode.bind(this));
        }
        
        // Envia passive IQ 'active' (seguindo padrão Baileys)
        await this.sendPassiveIq('active');
        
      } catch (err: any) {
        console.warn('⚠️ Falha ao enviar passive IQ inicial:', err);
      }
      
      await this.handleConnectionSuccess(node);
    });
    
    // Stream errors
    this.on('CB:stream:error', (node: any) => {
      this.handleStreamError(node);
    });
    
    // Connection failures
    this.on('CB:failure', (node: any) => {
      this.handleConnectionFailure(node);
    });

    // MD event handler - processa mensagens iq com conteúdo md
    this.on('CB:iq,md', async (stanza: any) => {
      await this.handleMdEvent(stanza);
    });
  }
  

  
  /**
   * Inicia processo de geração de QR codes seguindo padrão Baileys
   */

  
  /**
   * Processa evento pair-success seguindo padrão Baileys
   */
  private async handlePairSuccessEvent(stanza: any): Promise<void> {
    console.log('✅ Pareamento bem-sucedido:', stanza);
    
    try {
      if (!this.authState?.creds) {
        throw new Error('AuthState não disponível para pareamento');
      }

      const { reply, creds: updatedCreds } = configureSuccessfulPairing(stanza, this.authState.creds);
      
      console.log('🔄 Pareamento configurado com sucesso, conexão será reiniciada...');
      
      // Atualiza as credenciais
      Object.assign(this.authState.creds, updatedCreds);
      
      // Emite eventos seguindo padrão Baileys original
      this.emit('creds.update', updatedCreds);
      this.emit('connection.update', { isNewLogin: true, qr: undefined });
      
      // Envia resposta para o servidor
      await this.sendNode(reply);
      
      // Salva as credenciais se a função estiver disponível
      if (this.saveCreds) {
        await this.saveCreds();
      }
      
    } catch (error: any) {
      console.error('❌ Erro no pareamento:', error);
      
      // Evita emitir múltiplos eventos 'close' para o mesmo erro
      const errorMessage = error?.message || 'Erro no pareamento';
      if (!this.connectionClosed || this.lastCloseReason !== errorMessage) {
        this.connectionClosed = true;
        this.lastCloseReason = errorMessage;
        
        this.emit('connection.update', {
          connection: 'close',
          lastDisconnect: {
            error: error,
            date: new Date()
          }
        });
      }
    }
  }
  
  /**
   * Processa sucesso da conexão seguindo padrão Baileys
   */
  private async handleConnectionSuccess(node: any): Promise<void> {
    console.log('✅ Conexão estabelecida com sucesso:', node);
    
    try {
      // Upload de pre-keys e passive IQ serão feitos no evento CB:success
      // após o handshake estar completamente finalizado
      
      console.log('🌐 Conexão aberta para WhatsApp');
      
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
      
      // Emite evento connection.update seguindo padrão Baileys
      this.emit('connection.update', { connection: 'open' });
      
    } catch (error: any) {
      console.warn('⚠️ Erro no processamento do success:', error);
      // Mesmo com erro, consideramos a conexão aberta
      console.log('📡 Conexão aberta (com avisos)');
      this.emit('connection.update', { connection: 'open' });
    }
  }
  
  /**
   * Processa solicitação de pareamento (pair-device)
   */
  /**
   * Processa evento pair-device seguindo exatamente o padrão Baileys oficial
   */
  private async handlePairDevice(stanza: any): Promise<void> {
    try {
      // Primeiro envia resposta IQ (acknowledgment) - padrão Baileys oficial
      const iq = {
        tag: 'iq',
        attrs: {
          to: 's.whatsapp.net',
          type: 'result',
          id: stanza.attrs.id
        }
      };
      
      await this.sendNode(iq);
      
      // Extrai nós de referência QR diretamente do stanza - padrão Baileys oficial
      const pairDeviceNode = this.getBinaryNodeChild(stanza, 'pair-device');
      const refNodes = this.getBinaryNodeChildren(pairDeviceNode, 'ref');
      
      if (!refNodes || refNodes.length === 0) {
        console.error('❌ Nenhuma referência QR encontrada no pair-device');
        return;
      }
      
      // Log removido para evitar spam
      // console.log(`📱 Encontradas ${refNodes.length} referências QR`);
      
      // Prepara dados para QR seguindo padrão Baileys oficial
      const noiseKeyB64 = Buffer.from(this.authState!.creds.noiseKey.public).toString('base64');
      const identityKeyB64 = Buffer.from(this.authState!.creds.signedIdentityKey.public).toString('base64');
      const advB64 = this.authState!.creds.advSecretKey;
      
      // Log removido para evitar spam
      // console.log('🔑 Chaves preparadas para QR code');
      
      // Inicia geração de QR codes seguindo exatamente o padrão Baileys oficial
      let qrMs = 60_000; // tempo inicial para QR viver (60 segundos) - padrão Baileys oficial
      
      const genPairQR = () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          console.log('⚠️ WebSocket não está aberto, parando geração de QR');
          return;
        }

        const refNode = refNodes.shift();
        if (!refNode) {
          console.log('❌ Todas as referências QR foram utilizadas - encerrando por timeout');
          // Segue exatamente o padrão Baileys: DisconnectReason.timedOut
          this.emit('connection.update', { 
            connection: 'close',
            lastDisconnect: {
              error: new Error('QR refs attempts ended'),
              date: new Date()
            }
          });
          return;
        }

        // Extrai referência do nó - padrão Baileys oficial
        const ref = (refNode.content as Buffer).toString('utf-8');
        
        // Constrói QR code no formato WhatsApp oficial: ref,noiseKey,identityKey,advKey
        const qr = [ref, noiseKeyB64, identityKeyB64, advB64].join(',');
        
        // Logs de QR code removidos para evitar spam
        // console.log('\n🎯 ===== QR CODE GERADO (PADRÃO BAILEYS OFICIAL) =====');
        // console.log(`📱 QR Code: ${qr}`);
        // console.log(`📏 Tamanho: ${qr.length} caracteres`);
        // console.log(`⏰ Expira em: ${qrMs / 1000} segundos`);
        // console.log('🎯 ====================================================\n');
        
        // Emite evento connection.update com QR - padrão Baileys oficial
        this.emit('connection.update', { qr });
        
        // Agenda próximo QR code - padrão Baileys oficial
        this.qrTimer = setTimeout(genPairQR, qrMs);
        qrMs = 20_000; // QRs subsequentes duram 20 segundos - padrão Baileys oficial
      };
      
      // Inicia geração do primeiro QR code
      genPairQR();
      
    } catch (error) {
      console.error('❌ Erro ao processar pair-device:', error);
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
   * Inicia o processo de geração de QR codes com rotação automática
   */
  private startQRGeneration(): void {
    if (!this.qrRefs || this.qrRefs.length === 0) {
      console.log('❌ Nenhuma referência QR disponível');
      return;
    }

    let qrMs = 60000; // tempo inicial para QR viver (60 segundos)
    
    const genPairQR = () => {
      if (!this.isConnected) {
        console.log('⚠️ WebSocket desconectado, parando geração de QR');
        return;
      }

      // No Baileys oficial, os refs são consumidos sequencialmente com shift()
      // Isso garante que cada QR code use um ref único e fresco
      if (!this.qrRefs || this.qrRefs.length === 0) {
        console.log('❌ Todas as referências QR foram utilizadas');
        this.emit('connection.update', { 
          connection: 'close',
          lastDisconnect: {
            error: new Error('QR refs attempts ended'),
            date: new Date()
          }
        });
        return;
      }

      // Consome o próximo ref (padrão Baileys oficial)
      const refNode = this.qrRefs.shift()!;

      // Extrai referência do nó
      let ref = '';
      if (refNode.content) {
        if (Buffer.isBuffer(refNode.content)) {
          ref = refNode.content.toString('utf-8');
        } else if (typeof refNode.content === 'string') {
          ref = refNode.content;
        } else {
          console.error('❌ Formato de referência QR não suportado:', typeof refNode.content);
          return;
        }
      } else {
        console.error('❌ Nó ref sem conteúdo');
        return;
      }
      
      console.log('🔍 DEBUG: Referência extraída:', ref.substring(0, 50) + '...');
      
      // Constrói QR code no formato WhatsApp: ref,noiseKey,identityKey,advKey
      const qr = [ref, this.qrCredentials!.noiseKeyB64, this.qrCredentials!.identityKeyB64, this.qrCredentials!.advB64].join(',');
      
      console.log('\n🎯 ===== QR CODE GERADO =====');
      console.log(`📱 QR Code (${this.qrRefs.length} refs restantes)`);
      console.log(`📋 QR Code Completo: ${qr}`);
      console.log(`📏 Tamanho: ${qr.length} caracteres`);
      console.log(`⏰ Expira em: ${qrMs / 1000} segundos`);
      console.log('🎯 ============================\n');
      
      // Calcula tempo de expiração
      const expiresAt = new Date(Date.now() + qrMs);
      
      // Emite evento connection.update com QR (padrão Baileys)
      this.emit('connection.update', { 
        qr,
        qrTotal: this.qrRefs!.length,
        qrExpiresAt: expiresAt
      });
      
      // Agenda próximo QR code (QRs subsequentes são mais rápidos)
      this.qrTimer = setTimeout(genPairQR, qrMs);
      qrMs = 20000; // QRs subsequentes duram 20 segundos
      
      console.log(`⏰ Próximo QR code em ${qrMs / 1000} segundos (${this.qrRefs!.length} refs restantes)`);
    };
    
    // Inicia geração do primeiro QR
    console.log('🚀 Iniciando geração do primeiro QR code...');
    genPairQR();
  }

  /**
   * Para a geração de QR codes
   */
  private stopQRGeneration(): void {
    if (this.qrTimer) {
      clearTimeout(this.qrTimer);
      this.qrTimer = undefined;
      console.log('⏹️ Geração de QR codes interrompida');
    }
  }
  
  /**
   * Processa evento de pareamento bem-sucedido (pair-success) seguindo padrão Baileys
   */
  private async handlePairSuccess(stanza: any): Promise<void> {
    try {
      console.log('🎉 Pair-success recebido - processando seguindo padrão Baileys');
      
      // Para o timer de QR code imediatamente (como no Baileys oficial)
      this.stopQRGeneration();
      
      // Usa configureSuccessfulPairing do Baileys para processar o pareamento
      const { configureSuccessfulPairing } = require('../utils/ValidateConnection');
      const { reply, creds: updatedCreds } = configureSuccessfulPairing(stanza, this.authState!.creds);

      console.log('✅ Pareamento configurado com sucesso');
      console.log('📱 Me:', updatedCreds.me);
      console.log('🖥️ Platform:', updatedCreds.platform);

      // Emite evento de atualização das credenciais (padrão Baileys)
      this.emit('creds.update', updatedCreds);
      
      // Emite evento de conexão atualizada (padrão Baileys)
      this.emit('connection.update', { 
        isNewLogin: true, 
        qr: undefined 
      });

      // Envia resposta para o servidor (padrão Baileys)
      await this.sendNode(reply);
      console.log('✅ Resposta de pair-success enviada');
      
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
   * Processa erros de stream
   */
  private handleStreamError(node: any): void {
    // Erro de stream - log removido para evitar spam
    this.emit('stream-error', node);
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
   * CORRIGIDO: Só responde IQs do tipo 'get' para evitar loops infinitos
   */
  private async handleMdEvent(stanza: any): Promise<void> {
    try {
      // Log apenas para IQs importantes (pair-device, device-list, encrypt)
      const isImportantIq = stanza.content && Array.isArray(stanza.content) && 
        stanza.content.some((child: any) => 
          ['pair-device', 'device-list', 'encrypt', 'account'].includes(child.tag)
        );
      
      if (isImportantIq) {
        // console.log('\n📋 [MD EVENT] IQ MD importante recebido:', {
        //   type: stanza.attrs?.type,
        //   id: stanza.attrs?.id,
        //   contentTags: stanza.content.map((c: any) => c.tag)
        // });
      }
      
      // CORREÇÃO: Só responde IQs do tipo 'get' para evitar loops infinitos
      // type="get" → responde com result
      // type="set" → processa, mas nem sempre responde
      // type="result" → já é resposta, não precisa responder
      if (stanza.attrs?.type === 'get' && stanza.attrs?.id) {
        const iq = {
          tag: 'iq',
          attrs: {
            to: 's.whatsapp.net',
            type: 'result',
            id: stanza.attrs.id
          }
        };
        
        await this.sendNode(iq);
      } else if (stanza.attrs?.type && stanza.attrs.type !== 'get') {
        // Log apenas para debug quando não responder
        if (isImportantIq) {
          // console.log(`📋 [MD EVENT] IQ type="${stanza.attrs.type}" - não enviando resposta (evita loop)`);
        }
      }
      
      // Processa diferentes tipos de MD baseado no conteúdo (apenas log para importantes)
      if (stanza.content && Array.isArray(stanza.content)) {
        for (const child of stanza.content) {
          if (child.tag === 'device-list') {
          } else if (child.tag === 'encrypt') {
          } else if (child.tag === 'account') {
          } else if (child.tag === 'pair-device') {
          }
          // Não loga outros tipos para reduzir spam
        }
      }
      
      // Emite evento genérico para compatibilidade
      this.emit('md-event', stanza);
      
    } catch (error) {
       console.error('❌ Erro ao processar evento MD:', error);
       this.emit('connection.update', {
         connection: 'close',
         lastDisconnect: {
           error: new Error(`MD processing failed: ${error instanceof Error ? error.message : String(error)}`),
           date: new Date()
         }
       });
     }
  }
  
  /**
   * Desconecta do servidor
   */
  public disconnect(): void {
    console.log('🔌 Desconectando...');
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
    
    // Para geração de QR codes
    this.stopQRGeneration();
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
      
      // Verifica se passou muito tempo sem receber dados (como no Baileys)
      if (diff > KEEPALIVE_INTERVAL + 5000) {
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
        // Envia keep-alive usando IQ message (como no Baileys)
        this.sendKeepAliveIQ().catch(err => {
          console.error('❌ Erro ao enviar keep-alive IQ:', err);
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
      const keepAliveNode = {
        tag: 'iq',
        attrs: {
          id: this.generateMessageTag(),
          to: 's.whatsapp.net',
          type: 'get',
          xmlns: 'w:p'
        },
        content: [{ tag: 'ping', attrs: {} }]
      };
      
      console.log('🏓 Enviando keep-alive IQ...');
      await this.sendNode(keepAliveNode);
    } catch (error) {
      console.error('❌ Erro ao enviar keep-alive IQ:', error);
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
    return reconnectableCodes.includes(code) && this.reconnectAttempts < this.maxReconnectAttempts;
  }

  /**
   * Envia passive IQ seguindo padrão Baileys
   */
  private async sendPassiveIq(tag: 'passive' | 'active'): Promise<void> {
    const node = {
      tag: 'iq',
      attrs: {
        to: 's.whatsapp.net',
        xmlns: 'passive',
        type: 'set'
      },
      content: [{ tag, attrs: {} }]
    };
    
    console.log(`📤 Enviando passive IQ: ${tag}`);
    await this.sendNode(node);
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
    
    setTimeout(() => {
      this.connect().catch(error => {
        console.error('❌ Falha na reconexão:', error.message);
      });
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