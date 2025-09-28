import { randomBytes } from 'crypto';
import { Curve } from '../crypto/Curve25519';
import { Logger } from '../utils/Logger';
import * as fs from 'fs';
import * as path from 'path';
import { AuthStateManager, AuthenticationCreds, AuthenticationState } from './AuthStateManager';

/**
 * Helper para adicionar prefixo 0x05 nas chaves públicas para envio ao servidor
 */
export const generateSignalPubKey = (pubKey: Uint8Array): Buffer => 
  pubKey.length === 33 ? Buffer.from(pubKey) : Buffer.concat([Buffer.from([0x05]), Buffer.from(pubKey)]);

export interface AuthCredentials {
  clientId?: string;
  deviceId?: number;
  noiseKey: KeyPair;
  pairingEphemeralKeyPair: KeyPair;
  pairingCode?: string;
  identityKey: KeyPair;
  signedIdentityKey: KeyPair;
  signedPreKey: SignedKeyPair;
  registrationId: number;
  advSecretKey: string;
  processedHistoryMessages: any[];
  nextPreKeyId: number;
  firstUnuploadedPreKeyId: number;
  accountSyncCounter: number;
  accountSettings: {
    unarchiveChats: boolean;
  };
  registered: boolean;
  lastPropHash?: string;
  routingInfo?: Buffer;
  me?: {
    id: string;
    name?: string;
    lid?: string;
  };
  signalIdentities?: any[];
  myAppStateKeyId?: string;
  platform?: string;
}

export interface KeyPair {
  private: Uint8Array;
  public: Uint8Array;
}

export interface SignedKeyPair {
  keyPair: KeyPair;
  keyId: number;
  signature: Uint8Array;
}

export interface SessionData {
  instanceId: string;
  creds: AuthCredentials;
  keys: any; // Signal protocol keys
}

/**
 * Gerenciador de credenciais de autenticação compatível com Baileys
 */
export class CredentialsManager {
  private logger = new Logger();
  private sessionsDir: string;
  private authStateManager: AuthStateManager | null = null;

  constructor(sessionsDir: string = './sessions') {
    this.sessionsDir = sessionsDir;
    // AuthStateManager será inicializado quando necessário com instanceId
    this.ensureSessionsDirectory();
  }

  /**
   * Carrega credenciais existentes
   */
  public async loadCredentials(instanceId: string): Promise<AuthCredentials | null> {
    const sessionData = await this.loadSession(instanceId);
    return sessionData ? sessionData.creds : null;
  }

  /**
   * Cria novas credenciais usando padrão Baileys
   */
  public async createCredentials(instanceId: string): Promise<AuthCredentials> {
    const sessionFolder = path.join(this.sessionsDir, instanceId);
    const { state } = await this.authStateManager!.useMultiFileAuthState(sessionFolder);
    
    // Converte credenciais do Baileys para formato interno se necessário
    const credentials = this.convertBaileysCredsToInternal(state.creds);
    return credentials;
  }
  
  /**
   * Obtém estado de autenticação Baileys para uma instância
   */
  public async getBaileysAuthState(instanceId: string): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }> {
    if (!this.authStateManager) {
      this.authStateManager = new AuthStateManager(instanceId);
    }
    const sessionFolder = path.join(this.sessionsDir, instanceId);
    return await this.authStateManager.useMultiFileAuthState(sessionFolder);
  }

  /**
   * Converte credenciais do Baileys para formato interno
   */
  private convertBaileysCredsToInternal(creds: AuthenticationCreds): AuthCredentials {
    return {
      clientId: randomBytes(16).toString('base64'),
      deviceId: 0,
      noiseKey: {
        private: creds.noiseKey.private,
        public: creds.noiseKey.public
      },
      pairingEphemeralKeyPair: {
        private: creds.pairingEphemeralKeyPair.private,
        public: creds.pairingEphemeralKeyPair.public
      },
      pairingCode: creds.pairingCode,
      identityKey: {
        private: creds.signedIdentityKey.private,
        public: creds.signedIdentityKey.public
      },
      signedIdentityKey: {
        private: creds.signedIdentityKey.private,
        public: creds.signedIdentityKey.public
      },
      signedPreKey: {
        keyPair: {
          private: creds.signedPreKey.keyPair.private,
          public: creds.signedPreKey.keyPair.public
        },
        keyId: creds.signedPreKey.keyId,
        signature: creds.signedPreKey.signature
      },
      registrationId: creds.registrationId,
      advSecretKey: randomBytes(32).toString('base64'),
      processedHistoryMessages: [],
      nextPreKeyId: 1,
      firstUnuploadedPreKeyId: 1,
      accountSyncCounter: 0,
      accountSettings: {
        unarchiveChats: false
      },
      registered: false
    };
  }
  
  /**
   * Inicializa credenciais de autenticação baseado no padrão Baileys (mantido para compatibilidade)
   */
  public initAuthCreds(): AuthCredentials {
    // Gerar chaves usando libsignal como no Baileys original
    const identityKeyPair = Curve.generateKeyPair();
    const noiseKeyPair = Curve.generateKeyPair();
    const pairingKeyPair = Curve.generateKeyPair();
    
    const identityKey: KeyPair = {
      private: new Uint8Array(identityKeyPair.private),
      public: new Uint8Array(identityKeyPair.public)
    };
    
    // No Baileys original, signedIdentityKey é a MESMA chave que identityKey
    const signedIdentityKey: KeyPair = {
      private: new Uint8Array(identityKeyPair.private),
      public: new Uint8Array(identityKeyPair.public)
    };
    
    const clientId = randomBytes(16).toString('base64');
    
    return {
      clientId,
      deviceId: 0,
      noiseKey: {
        private: new Uint8Array(noiseKeyPair.private),
        public: new Uint8Array(noiseKeyPair.public)
      },
      pairingEphemeralKeyPair: {
        private: new Uint8Array(pairingKeyPair.private),
        public: new Uint8Array(pairingKeyPair.public)
      },
      pairingCode: undefined,
      identityKey: identityKey,
      signedIdentityKey: signedIdentityKey,
      signedPreKey: this.generateSignedPreKey(identityKeyPair, 1),
      registrationId: this.generateRegistrationId(),
      advSecretKey: randomBytes(32).toString('base64'),
      processedHistoryMessages: [],
      nextPreKeyId: 1,
      firstUnuploadedPreKeyId: 1,
      accountSyncCounter: 0,
      accountSettings: {
        unarchiveChats: false
      },
      registered: false,
      lastPropHash: undefined,
      routingInfo: undefined,
      me: undefined,
      signalIdentities: [], // Começa vazio, será populado após pair-success
      myAppStateKeyId: undefined,
      platform: undefined
    };
  }



  /**
   * Gera um ID de registro aleatório seguindo o padrão do Baileys (14 bits)
   */
  private generateRegistrationId(): number {
    // Baileys usa exatamente esta implementação para 14 bits
    return Math.floor(Math.random() * 16383) + 1; // 1 a 16383 (14 bits)
  }

  private generateSignedPreKey(identityKeyPair: any, keyId: number): SignedKeyPair {
    const preKey = Curve.generateKeyPair();
    const pubKeyWithPrefix = Buffer.concat([Buffer.from([0x05]), Buffer.from(preKey.public)]);
    const signature = Curve.sign(identityKeyPair.private, pubKeyWithPrefix);

    return {
      keyPair: {
        private: new Uint8Array(preKey.private),
        public: new Uint8Array(preKey.public)
      },
      keyId,
      signature: new Uint8Array(signature)
    };
  }

  /**
   * Salva as credenciais em arquivo
   */
  public async saveSession(instanceId: string, sessionData: SessionData): Promise<void> {
    try {
      const sessionPath = path.join(this.sessionsDir, `${instanceId}.json`);
      
      // Serializa os Buffers para base64
      const serializedData = this.serializeSessionData(sessionData);
      
      await fs.promises.writeFile(sessionPath, JSON.stringify(serializedData, null, 2));
      
      Logger.info(`Sessão salva para instância: ${instanceId}`);
    } catch (error) {
      Logger.error('Erro ao salvar sessão:', error);
      throw error;
    }
  }

  /**
   * Carrega as credenciais do arquivo
   */
  public async loadSession(instanceId: string): Promise<SessionData | null> {
    try {
      const sessionPath = path.join(this.sessionsDir, `${instanceId}.json`);
      
      if (!fs.existsSync(sessionPath)) {
        return null;
      }
      
      const data = await fs.promises.readFile(sessionPath, 'utf8');
      const parsedData = JSON.parse(data);
      
      // Deserializa os Buffers de base64
      const sessionData = this.deserializeSessionData(parsedData);
      
      Logger.info(`Sessão carregada para instância: ${instanceId}`);
      return sessionData;
    } catch (error) {
      Logger.error('Erro ao carregar sessão:', error);
      return null;
    }
  }

  /**
   * Remove a sessão
   */
  public async removeSession(instanceId: string): Promise<void> {
    try {
      const sessionPath = path.join(this.sessionsDir, `${instanceId}.json`);
      
      if (fs.existsSync(sessionPath)) {
        await fs.promises.unlink(sessionPath);
        Logger.info(`Sessão removida para instância: ${instanceId}`);
      }
    } catch (error) {
      Logger.error('Erro ao remover sessão:', error);
      throw error;
    }
  }

  /**
   * Verifica se existe uma sessão salva
   */
  public hasSession(instanceId: string): boolean {
    const sessionPath = path.join(this.sessionsDir, `${instanceId}.json`);
    return fs.existsSync(sessionPath);
  }

  /**
   * Cria dados de sessão
   */
  private createSessionData(instanceId: string, creds: AuthCredentials): SessionData {
    return {
      instanceId,
      creds,
      keys: {} // Inicializar com keys vazias
    };
  }

  /**
   * Serializa os dados da sessão convertendo Buffers para base64
   */
  private serializeSessionData(sessionData: SessionData): any {
    return {
      instanceId: sessionData.instanceId,
      creds: this.serializeCredentials(sessionData.creds),
      keys: sessionData.keys
    };
  }

  /**
   * Deserializa os dados da sessão convertendo base64 para Buffers
   */
  private deserializeSessionData(data: any): SessionData {
    return {
      instanceId: data.instanceId,
      creds: this.deserializeCredentials(data.creds),
      keys: data.keys || {}
    };
  }

  /**
   * Serializa as credenciais
   */
  private serializeCredentials(creds: AuthCredentials): any {
    return {
      ...creds,
      noiseKey: {
        private: Buffer.from(creds.noiseKey.private).toString('base64'),
        public: Buffer.from(creds.noiseKey.public).toString('base64')
      },
      pairingEphemeralKeyPair: {
        private: Buffer.from(creds.pairingEphemeralKeyPair.private).toString('base64'),
        public: Buffer.from(creds.pairingEphemeralKeyPair.public).toString('base64')
      },
      identityKey: {
        private: Buffer.from(creds.identityKey.private).toString('base64'),
        public: Buffer.from(creds.identityKey.public).toString('base64')
      },
      signedIdentityKey: {
        private: Buffer.from(creds.signedIdentityKey.private).toString('base64'),
        public: Buffer.from(creds.signedIdentityKey.public).toString('base64')
      },
      signedPreKey: {
        keyPair: {
          private: Buffer.from(creds.signedPreKey.keyPair.private).toString('base64'),
          public: Buffer.from(generateSignalPubKey(creds.signedPreKey.keyPair.public)).toString('base64')
        },
        keyId: creds.signedPreKey.keyId,
        signature: Buffer.from(creds.signedPreKey.signature).toString('base64')
      },
      routingInfo: creds.routingInfo?.toString('base64')
    };
  }

  /**
   * Deserializa as credenciais
   */
  private deserializeCredentials(data: any): AuthCredentials {
    return {
      ...data,
      noiseKey: {
        private: new Uint8Array(Buffer.from(data.noiseKey.private, 'base64')),
        public: new Uint8Array(Buffer.from(data.noiseKey.public, 'base64'))
      },
      pairingEphemeralKeyPair: {
        private: new Uint8Array(Buffer.from(data.pairingEphemeralKeyPair.private, 'base64')),
        public: new Uint8Array(Buffer.from(data.pairingEphemeralKeyPair.public, 'base64'))
      },
      identityKey: {
        private: new Uint8Array(Buffer.from(data.identityKey.private, 'base64')),
        public: new Uint8Array(Buffer.from(data.identityKey.public, 'base64'))
      },
      signedIdentityKey: {
        private: new Uint8Array(Buffer.from(data.signedIdentityKey.private, 'base64')),
        public: new Uint8Array(Buffer.from(data.signedIdentityKey.public, 'base64'))
      },
      signedPreKey: {
        keyPair: {
          private: new Uint8Array(Buffer.from(data.signedPreKey.keyPair.private, 'base64')),
          public: new Uint8Array(Buffer.from(data.signedPreKey.keyPair.public, 'base64'))
        },
        keyId: data.signedPreKey.keyId,
        signature: new Uint8Array(Buffer.from(data.signedPreKey.signature, 'base64'))
      },
      routingInfo: data.routingInfo ? Buffer.from(data.routingInfo, 'base64') : undefined
    };
  }

  /**
   * Atualiza credenciais após pair-success
   */
  public updateCredentialsAfterPairing(creds: AuthCredentials, jid: string, displayName?: string): void {
    // Popula informações do usuário
    creds.me = {
      id: jid,
      name: displayName,
      lid: undefined
    };

    // Popula signalIdentities com a identidade do dispositivo
    creds.signalIdentities = [{
      identifier: {
        name: creds.clientId!,
        deviceId: creds.deviceId ?? 0
      },
      identifierKey: generateSignalPubKey(creds.signedIdentityKey.public)
    }];

    // Marca como registrado
    creds.registered = true;
  }

  /**
   * Garante que o diretório de sessões existe
   */
  private ensureSessionsDirectory(): void {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }
}