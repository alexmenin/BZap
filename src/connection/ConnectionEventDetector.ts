// ConnectionEventDetector.ts - Sistema de detecção de eventos de conexão equivalente ao Baileys

import { EventEmitter } from 'events';
import { Logger } from '../utils/Logger';

/**
 * Estados de conexão baseados no Baileys
 */
export enum ConnectionState {
  close = 'close',
  connecting = 'connecting',
  open = 'open'
}

/**
 * Razões de desconexão baseadas no Baileys
 */
export enum DisconnectReason {
  connectionClosed = 'connectionClosed',
  connectionLost = 'connectionLost',
  connectionReplaced = 'connectionReplaced',
  timedOut = 'timedOut',
  loggedOut = 'loggedOut',
  badSession = 'badSession',
  restartRequired = 'restartRequired',
  multideviceMismatch = 'multideviceMismatch'
}

/**
 * Interface para atualização de conexão
 */
export interface ConnectionUpdate {
  connection: ConnectionState;
  lastDisconnect?: {
    error?: Error;
    date: Date;
    reason?: DisconnectReason;
  };
  qr?: string;
  isNewLogin?: boolean;
  isOnline?: boolean;
  receivedPendingNotifications?: boolean;
}

/**
 * Interface para eventos de conexão (simplificada - foco em handshake e QR)
 */
export interface ConnectionEvents {
  'connection.update': (update: ConnectionUpdate) => void;
  'creds.update': (creds: any) => void;
  // Removidos eventos de mensagens, chats, contatos e presença
  // Mantidos apenas os essenciais para handshake e QR
}

/**
 * Detector de eventos de conexão baseado no protocolo WhatsApp
 */
export class ConnectionEventDetector extends EventEmitter {
  private currentState: ConnectionState = ConnectionState.close;
  private lastDisconnect?: ConnectionUpdate['lastDisconnect'];
  private connectionStartTime?: Date;
  private heartbeatInterval?: NodeJS.Timeout;
  private isAuthenticated = false;
  private qrCode?: string;
  private webSocket?: any;

  constructor() {
    super();
    this.setupHeartbeat();
  }

  /**
   * Processa dados recebidos do WebSocket para detectar eventos
   */
  public processWebSocketData(data: Buffer): void {
    try {
      // Debug logs removidos para evitar spam
      // const dataPreview = data.toString('hex').substring(0, 100);
      // console.log(`🔍 [DEBUG] Processando mensagem WebSocket: ${data.length} bytes - Preview: ${dataPreview}`);
      // console.log(`🔍 [DEBUG] Estado atual: ${this.currentState}, QR existe: ${!!this.qrCode}, Autenticado: ${this.isAuthenticated}`);
      
      // Detecta diferentes tipos de mensagens baseado no protocolo WhatsApp
      const messageType = this.detectMessageType(data);
      
      // Log detalhado para debug
      Logger.debug(`🔍 Processando mensagem tipo: ${messageType}, tamanho: ${data.length}, estado: ${this.currentState}`);
      // console.log(`🔍 [DEBUG] Tipo de mensagem detectado: ${messageType}`);
      
      switch (messageType) {
        case 'server_hello':
          // Debug logs removidos para evitar spam
          // console.log(`🔍 [DEBUG] Server Hello detectado`);
          // Server Hello só é válido se estivermos aguardando conexão
          if (this.currentState === ConnectionState.connecting) {
            // console.log(`🔍 [DEBUG] Processando Server Hello (estado válido)`);
            this.handleServerHello(data);
          } else {
            // console.log(`🔍 [DEBUG] Server Hello ignorado - estado inválido: ${this.currentState}`);
          }
          break;
        case 'pair_device':
          // console.log(`🔍 [DEBUG] Pair Device detectado`);
          // Pair device só é válido se estivermos conectando
          if (this.currentState === ConnectionState.connecting) {
            // console.log(`🔍 [DEBUG] Processando Pair Device (estado válido)`);
            this.handlePairDevice(data);
          } else {
            // console.log(`🔍 [DEBUG] Pair Device ignorado - estado inválido: ${this.currentState}`);
          }
          break;
        case 'pair_success':
          // console.log(`🔍 [DEBUG] Pair Success detectado`);
          // Pair success só é válido se estivermos conectando e após QR gerado
          if (this.currentState === ConnectionState.connecting && this.qrCode) {
            // console.log(`🔍 [DEBUG] Processando Pair Success (estado e QR válidos)`);
            this.handlePairSuccess(data);
          } else {
            // console.log(`🔍 [DEBUG] Pair Success ignorado - estado: ${this.currentState}, QR: ${!!this.qrCode}`);
          }
          break;
        case 'auth_success':
          // console.log(`🔍 [DEBUG] Auth Success detectado`);
          // Auth success só é válido se estivermos conectando e já autenticados parcialmente
          if (this.currentState === ConnectionState.connecting) {
            // console.log(`🔍 [DEBUG] Processando Auth Success (estado válido)`);
            this.handleAuthSuccess(data);
          } else {
            // console.log(`🔍 [DEBUG] Auth Success ignorado - estado inválido: ${this.currentState}`);
          }
          break;
        case 'disconnect':
          // console.log(`🔍 [DEBUG] Disconnect detectado`);
          this.handleDisconnect(data);
          break;
        case 'heartbeat':
          // console.log(`🔍 [DEBUG] Heartbeat detectado`);
          this.handleHeartbeat(data);
          break;
        case 'message':
          // console.log(`🔍 [DEBUG] Message detectado`);
          this.handleMessage(data);
          break;
        case 'presence':
          // console.log(`🔍 [DEBUG] Presence detectado`);
          this.handlePresence(data);
          break;
        default:
          // console.log(`🔍 [DEBUG] Mensagem não reconhecida`);
          Logger.debug(`Tipo de mensagem não reconhecido: ${data.length} bytes`);
      }
    } catch (error) {
      Logger.error('Erro ao processar dados do WebSocket:', error);
    }
  }

  /**
   * Detecta o tipo de mensagem baseado no conteúdo
   */
  private detectMessageType(data: Buffer): string {
    if (data.length === 0) return 'unknown';

    // Converte para hex e string para análise
    const hex = data.toString('hex');
    const str = data.toString('utf8', 0, Math.min(data.length, 100));

    // Detecta Server Hello (resposta ao Client Hello)
    if (this.isServerHello(data)) {
      return 'server_hello';
    }

    // Detecta pair-device (solicitação de pareamento)
    if (this.isPairDevice(data)) {
      return 'pair_device';
    }

    // Detecta pair-success (QR code escaneado)
    if (this.isPairSuccess(data)) {
      return 'pair_success';
    }

    // Detecta autenticação bem-sucedida
    if (this.isAuthSuccess(data)) {
      return 'auth_success';
    }

    // Detecta desconexão
    if (this.isDisconnect(data)) {
      return 'disconnect';
    }

    // Detecta heartbeat/keepalive
    if (this.isHeartbeat(data)) {
      return 'heartbeat';
    }

    // Detecta mensagens normais
    if (this.isMessage(data)) {
      return 'message';
    }

    // Detecta atualizações de presença
    if (this.isPresence(data)) {
      return 'presence';
    }

    return 'unknown';
  }

  /**
   * Verifica se é Server Hello
   */
  private isServerHello(data: Buffer): boolean {
    // Server Hello tem características específicas:
    // - Tamanho típico entre 100-500 bytes
    // - Contém estruturas protobuf específicas
    if (data.length < 50 || data.length > 1000) {
      return false;
    }

    const hex = data.toString('hex');
    
    // Padrões típicos de Server Hello
    const patterns = [
      '0a20', // Campo 1, tipo bytes, 32 bytes (ephemeral key)
      '1220', // Campo 2, tipo bytes, 32 bytes (static key)
      '1a'    // Campo 3, tipo bytes (payload)
    ];

    let matchCount = 0;
    for (const pattern of patterns) {
      if (hex.includes(pattern)) {
        matchCount++;
      }
    }

    return matchCount >= 2;
  }

  /**
   * Verifica se é pair-device
   */
  private isPairDevice(data: Buffer): boolean {
    try {
      // Pair-device deve ser uma mensagem específica do protocolo WhatsApp
      // Deve conter estrutura protobuf específica e não apenas texto genérico
      
      if (data.length < 20 || data.length > 2000) {
        console.log(`🔍 [DEBUG] isPairDevice: Tamanho inválido ${data.length}`);
        return false;
      }
      
      const dataStr = data.toString('utf8', 0, Math.min(data.length, 500));
      const dataHex = data.toString('hex');
      
      // Padrões MUITO específicos para pair-device real do WhatsApp
      const specificPatterns = [
        'CB:iq,type:set,pair-device',  // Formato específico do Baileys
        'CB:iq,,pair-device',          // Formato alternativo
        'pair-device',                 // Mas apenas se vier em contexto específico
      ];
      
      // Deve conter pelo menos um padrão específico E ter estrutura protobuf
      let hasSpecificPattern = false;
      let foundPattern = '';
      for (const pattern of specificPatterns) {
        if (dataStr.includes(pattern)) {
          hasSpecificPattern = true;
          foundPattern = pattern;
          break;
        }
      }
      
      // Se não tem padrão específico, não é pair-device
      if (!hasSpecificPattern) {
        console.log(`🔍 [DEBUG] isPairDevice: Nenhum padrão específico encontrado`);
        return false;
      }
      
      // Verifica se tem estrutura protobuf típica (campos com tags)
      const hasProtobufStructure = /\x08[\x01-\x7f]|\x12[\x01-\x7f]|\x1a[\x01-\x7f]/.test(data.toString('binary'));
      
      const result = hasSpecificPattern && hasProtobufStructure;
      console.log(`🔍 [DEBUG] isPairDevice: Padrão '${foundPattern}' encontrado, protobuf: ${hasProtobufStructure}, resultado: ${result}`);
      
      return result;
    } catch (error) {
      console.log(`🔍 [DEBUG] isPairDevice: Erro ${error}`);
      return false;
    }
  }

  /**
   * Verifica se é pair-success
   */
  private isPairSuccess(data: Buffer): boolean {
    try {
      // Pair-success deve ser uma mensagem específica do protocolo WhatsApp
      // Deve conter estrutura protobuf específica e não apenas texto genérico
      
      if (data.length < 20 || data.length > 1000) {
        console.log(`🔍 [DEBUG] isPairSuccess: Tamanho inválido ${data.length}`);
        return false;
      }
      
      const dataStr = data.toString('utf8', 0, Math.min(data.length, 500));
      const dataHex = data.toString('hex');
      
      // Padrões MUITO específicos para pair-success real do WhatsApp
      const specificPatterns = [
        'CB:iq,,pair-success',  // Formato específico do Baileys
        'pair-success',         // Mas apenas se vier em contexto específico
      ];
      
      // Deve conter pelo menos um padrão específico E ter estrutura protobuf
      let hasSpecificPattern = false;
      let foundPattern = '';
      for (const pattern of specificPatterns) {
        if (dataStr.includes(pattern)) {
          hasSpecificPattern = true;
          foundPattern = pattern;
          break;
        }
      }
      
      // Se não tem padrão específico, não é pair-success
      if (!hasSpecificPattern) {
        console.log(`🔍 [DEBUG] isPairSuccess: Nenhum padrão específico encontrado`);
        return false;
      }
      
      // Verifica se tem estrutura protobuf típica (campos com tags)
      const hasProtobufStructure = /\x08[\x01-\x7f]|\x12[\x01-\x7f]|\x1a[\x01-\x7f]/.test(data.toString('binary'));
      
      const result = hasSpecificPattern && hasProtobufStructure;
      console.log(`🔍 [DEBUG] isPairSuccess: Padrão '${foundPattern}' encontrado, protobuf: ${hasProtobufStructure}, resultado: ${result}`);
      
      return result;
    } catch (error) {
      console.log(`🔍 [DEBUG] isPairSuccess: Erro ${error}`);
      return false;
    }
  }

  /**
   * Verifica se é autenticação bem-sucedida
   */
  private isAuthSuccess(data: Buffer): boolean {
    try {
      // Auth success deve ser uma resposta específica após handshake completo
      // Não pode ser apenas texto genérico
      
      if (data.length < 30 || data.length > 2000) {
        console.log(`🔍 [DEBUG] isAuthSuccess: Tamanho inválido ${data.length}`);
        return false;
      }
      
      const dataStr = data.toString('utf8', 0, Math.min(data.length, 500));
      const dataHex = data.toString('hex');
      
      // Padrões muito específicos para autenticação bem-sucedida
      const authSuccessPatterns = [
        'CB:success',           // Formato específico do Baileys
        'auth-success',         // Mensagem específica de auth
        'login-success',        // Login bem-sucedido
      ];
      
      // Deve conter padrão específico de auth success
      let hasAuthPattern = false;
      let foundPattern = '';
      for (const pattern of authSuccessPatterns) {
        if (dataStr.includes(pattern)) {
          hasAuthPattern = true;
          foundPattern = pattern;
          break;
        }
      }
      
      if (!hasAuthPattern) {
        console.log(`🔍 [DEBUG] isAuthSuccess: Nenhum padrão de auth encontrado`);
        return false;
      }
      
      // Deve conter dados de sessão/credenciais (indicativo de auth real)
      const hasSessionData = dataStr.includes('creds') || 
                           dataStr.includes('keys') || 
                           dataStr.includes('session') ||
                           dataHex.includes('637265647') || // 'creds' em hex
                           dataHex.includes('6b657973');    // 'keys' em hex
      
      const result = hasAuthPattern && hasSessionData;
      console.log(`🔍 [DEBUG] isAuthSuccess: Padrão '${foundPattern}' encontrado, dados sessão: ${hasSessionData}, resultado: ${result}`);
      
      return result;
    } catch (error) {
      console.log(`🔍 [DEBUG] isAuthSuccess: Erro ${error}`);
      return false;
    }
  }

  /**
   * Verifica se é desconexão
   */
  private isDisconnect(data: Buffer): boolean {
    const str = data.toString('utf8');
    
    const disconnectPatterns = [
      'disconnect',
      'logout',
      'close',
      'terminated',
      'banned'
    ];

    return disconnectPatterns.some(pattern => str.toLowerCase().includes(pattern));
  }

  /**
   * Verifica se é heartbeat
   */
  private isHeartbeat(data: Buffer): boolean {
    // Heartbeat geralmente são mensagens pequenas e regulares
    return data.length <= 10 && data.length > 0;
  }

  /**
   * Verifica se é mensagem normal
   */
  private isMessage(data: Buffer): boolean {
    // Mensagens normais têm tamanho variável e estrutura protobuf
    return data.length > 20 && this.hasProtobufStructure(data);
  }

  /**
   * Verifica se é atualização de presença
   */
  private isPresence(data: Buffer): boolean {
    const str = data.toString('utf8');
    return str.includes('presence') || str.includes('typing') || str.includes('online');
  }

  /**
   * Verifica se tem estrutura protobuf
   */
  private hasProtobufStructure(data: Buffer): boolean {
    if (data.length < 2) return false;
    
    // Verifica padrões típicos de protobuf
    const firstByte = data[0];
    return (firstByte & 0x80) === 0 || // Campo com número baixo
           (firstByte >= 0x08 && firstByte <= 0x7F); // Padrões comuns
  }

  /**
   * Manipula Server Hello
   */
  private handleServerHello(data: Buffer): void {
    Logger.info('📨 Server Hello recebido');
    
    if (this.currentState !== ConnectionState.connecting) {
      this.updateConnectionState(ConnectionState.connecting);
    }
  }

  /**
   * Manipula pair-device (solicitação de pareamento)
   */
  private handlePairDevice(data: Buffer): void {
    Logger.info('📱 Pair-device recebido - iniciando geração de QR');
    console.log('🔑 Pair-device detectado - emitindo evento connection.pair-device');
    // Debug logs removidos para evitar spam
    // console.log(`🔍 [DEBUG] Pair device detectado - Estado atual: ${this.currentState}`);
    // console.log(`🔍 [DEBUG] Dados da mensagem (primeiros 100 bytes): ${data.toString('hex').substring(0, 200)}`);
    
    // Emite evento específico para que o WebSocketClient possa processar
    this.emit('connection.pair-device', data);
    
    // Atualiza estado para indicar que estamos aguardando QR
    this.updateConnectionState(ConnectionState.connecting, {
      isNewLogin: true
    });
  }

  /**
   * Manipula pair-success (QR escaneado)
   */
  private handlePairSuccess(data: Buffer): void {
    Logger.info('✅ QR Code escaneado com sucesso');
    console.log('🎉 QR code escaneado com sucesso!');
    // Debug logs removidos para evitar spam
    // console.log(`🔍 [DEBUG] Pair success detectado - Estado atual: ${this.currentState}, QR existe: ${!!this.qrCode}`);
    // console.log(`🔍 [DEBUG] Dados da mensagem (primeiros 100 bytes): ${data.toString('hex').substring(0, 200)}`);
    
    this.updateConnectionState(ConnectionState.connecting, {
      isNewLogin: true
    });
  }

  /**
   * Manipula autenticação bem-sucedida
   */
  private handleAuthSuccess(data: Buffer): void {
    Logger.info('🎉 Autenticação bem-sucedida');
    console.log('✅ Autenticação bem-sucedida!');
    // Debug logs removidos para evitar spam
    // console.log(`🔍 [DEBUG] Auth success detectado - Estado atual: ${this.currentState}, Já autenticado: ${this.isAuthenticated}`);
    // console.log(`🔍 [DEBUG] Dados da mensagem (primeiros 100 bytes): ${data.toString('hex').substring(0, 200)}`);
    
    this.isAuthenticated = true;
    this.updateConnectionState(ConnectionState.open, {
      isNewLogin: true,
      isOnline: true,
      receivedPendingNotifications: false
    });
  }

  /**
   * Manipula desconexão
   */
  private handleDisconnect(data: Buffer): void {
    Logger.warn('⚠️ Desconexão detectada');
    
    const reason = this.determineDisconnectReason(data);
    this.lastDisconnect = {
      error: new Error('Conexão perdida'),
      date: new Date(),
      reason
    };
    
    this.updateConnectionState(ConnectionState.close);
  }

  /**
   * Manipula heartbeat
   */
  private handleHeartbeat(data: Buffer): void {
    Logger.debug('💓 Heartbeat recebido');
    // Atualiza timestamp da última atividade
  }

  /**
   * Manipula mensagens normais (simplificado - apenas log)
   */
  private handleMessage(data: Buffer): void {
    Logger.debug('📱 Mensagem recebida - ignorada (foco em handshake/QR)');
    // Removido processamento de mensagens - foco apenas em handshake e QR
  }

  /**
   * Manipula atualizações de presença (simplificado - apenas log)
   */
  private handlePresence(data: Buffer): void {
    Logger.debug('👤 Atualização de presença - ignorada (foco em handshake/QR)');
    // Removido processamento de presença - foco apenas em handshake e QR
  }

  /**
   * Determina a razão da desconexão
   */
  private determineDisconnectReason(data: Buffer): DisconnectReason {
    const str = data.toString('utf8').toLowerCase();
    
    if (str.includes('logout')) return DisconnectReason.loggedOut;
    if (str.includes('replaced')) return DisconnectReason.connectionReplaced;
    if (str.includes('timeout')) return DisconnectReason.timedOut;
    if (str.includes('bad') || str.includes('invalid')) return DisconnectReason.badSession;
    if (str.includes('restart')) return DisconnectReason.restartRequired;
    if (str.includes('multidevice')) return DisconnectReason.multideviceMismatch;
    
    return DisconnectReason.connectionLost;
  }

  /**
   * Atualiza o estado da conexão e emite evento
   */
  private updateConnectionState(newState: ConnectionState, additionalData?: Partial<ConnectionUpdate>): void {
    const oldState = this.currentState;
    this.currentState = newState;
    
    const update: ConnectionUpdate = {
      connection: newState,
      lastDisconnect: this.lastDisconnect,
      qr: this.qrCode,
      ...additionalData
    };
    
    Logger.info(`🔄 Estado da conexão: ${oldState} → ${newState}`);
    // Debug logs removidos para evitar spam
    // console.log(`🔍 [DEBUG] MUDANÇA DE ESTADO: ${oldState} → ${newState}`);
    // console.log(`🔍 [DEBUG] Additional data: ${JSON.stringify(additionalData || {})}`);
    // console.log(`🔍 [DEBUG] Stack trace:`, new Error().stack?.split('\n').slice(1, 6).join('\n'));
    
    this.emit('connection.update', update);
  }

  /**
   * Define QR code
   */
  public setQRCode(qr: string): void {
    this.qrCode = qr;
    this.updateConnectionState(this.currentState, { qr });
  }

  /**
   * Inicia conexão
   */
  public startConnection(): void {
    this.connectionStartTime = new Date();
    this.updateConnectionState(ConnectionState.connecting);
  }

  /**
   * Força desconexão
   */
  public forceDisconnect(reason: DisconnectReason, error?: Error): void {
    this.lastDisconnect = {
      error: error || new Error('Desconexão forçada'),
      date: new Date(),
      reason
    };
    
    this.updateConnectionState(ConnectionState.close);
  }

  /**
   * Configura heartbeat interno
   */
  private setupHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.currentState === ConnectionState.open) {
        // Verifica se a conexão ainda está ativa
        const now = new Date();
        const timeSinceStart = this.connectionStartTime ? 
          now.getTime() - this.connectionStartTime.getTime() : 0;
        
        if (timeSinceStart > 300000) { // 5 minutos sem atividade
          Logger.warn('⚠️ Conexão inativa detectada');
          this.forceDisconnect(DisconnectReason.timedOut);
        }
      }
    }, 30000); // Verifica a cada 30 segundos
  }

  /**
   * Obtém estado atual
   */
  public getCurrentState(): ConnectionState {
    return this.currentState;
  }

  /**
   * Verifica se está autenticado
   */
  public isAuthenticatedState(): boolean {
    return this.isAuthenticated;
  }

  /**
   * Define WebSocket
   */
  public setWebSocket(ws: any): void {
    this.webSocket = ws;
  }

  /**
   * Cleanup
   */
  public cleanup(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    
    this.currentState = ConnectionState.close;
    this.isAuthenticated = false;
    this.qrCode = undefined;
    this.webSocket = undefined;
  }

  /**
   * Destroy
   */
  public destroy(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    
    this.removeAllListeners();
  }
}