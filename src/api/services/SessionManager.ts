// services/SessionManager.ts - Gerenciador de sessões e autenticação

import { promises as fs } from 'fs';
import { join } from 'path';
import { Logger } from '../../utils/Logger';
import { InstanceConfig } from './InstanceManager';

/**
 * Interface para estado de autenticação
 */
export interface AuthState {
  creds?: {
    noiseKey?: Buffer;
    signedIdentityKey?: Buffer;
    signedPreKey?: Buffer;
    identityKey?: Buffer;
    registrationId?: number;
    advSecretKey?: string;
    nextPreKeyId?: number;
    firstUnuploadedPreKeyId?: number;
    serverHasPreKeys?: boolean;
  };
  keys?: {
    preKeys?: { [keyId: number]: Buffer };
    sessions?: { [jid: string]: any };
    senderKeys?: { [groupId: string]: { [senderKeyId: string]: Buffer } };
    appStateSyncKeys?: { [keyId: string]: any };
    appStateVersions?: { [name: string]: number };
  };
  deviceId?: string;
  phoneNumber?: string;
  profileName?: string;
  platform?: string;
  lastAccountSyncTimestamp?: number;
}

/**
 * Interface para dados de sessão
 */
export interface SessionData {
  instanceId: string;
  authState: AuthState;
  createdAt: Date;
  updatedAt: Date;
  lastAccess: Date;
}

/**
 * Gerenciador de sessões
 * Responsável por salvar e carregar estados de autenticação
 */
export class SessionManager {
  private static instance: SessionManager;
  private readonly sessionsDir: string;
  private readonly configsDir: string;
  private sessionCache: Map<string, SessionData> = new Map();
  private configCache: Map<string, InstanceConfig> = new Map();

  private constructor() {
    this.sessionsDir = join(process.cwd(), 'sessions');
    this.configsDir = join(process.cwd(), 'configs');
    
    this.ensureDirectories();
    
    Logger.info('💾 SessionManager inicializado');
  }

  /**
   * Obtém a instância singleton
   */
  public static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  /**
   * Garante que os diretórios existem
   */
  private async ensureDirectories(): Promise<void> {
    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
      await fs.mkdir(this.configsDir, { recursive: true });
      
      Logger.info(`📁 Diretórios de sessão criados: ${this.sessionsDir}`);
    } catch (error) {
      Logger.error('❌ Erro ao criar diretórios de sessão:', error);
      throw error;
    }
  }

  /**
   * Salva configuração de instância
   */
  public async saveInstanceConfig(instanceId: string, config: InstanceConfig): Promise<void> {
    try {
      const configPath = join(this.configsDir, `${instanceId}.json`);
      
      const configData = {
        ...config,
        updatedAt: new Date().toISOString()
      };
      
      await fs.writeFile(configPath, JSON.stringify(configData, null, 2), 'utf8');
      
      // Atualiza cache
      this.configCache.set(instanceId, config);
      
      Logger.info(`💾 Configuração salva para instância: ${instanceId}`);
      
    } catch (error) {
      Logger.error(`❌ Erro ao salvar configuração da instância ${instanceId}:`, error);
      throw error;
    }
  }

  /**
   * Carrega configuração de instância
   */
  public async getInstanceConfig(instanceId: string): Promise<InstanceConfig | null> {
    try {
      // Verifica cache primeiro
      if (this.configCache.has(instanceId)) {
        return this.configCache.get(instanceId)!;
      }
      
      const configPath = join(this.configsDir, `${instanceId}.json`);
      
      try {
        const configData = await fs.readFile(configPath, 'utf8');
        const config = JSON.parse(configData) as InstanceConfig;
        
        // Atualiza cache
        this.configCache.set(instanceId, config);
        
        return config;
      } catch (fileError) {
        if ((fileError as any).code === 'ENOENT') {
          return null; // Arquivo não existe
        }
        throw fileError;
      }
      
    } catch (error) {
      Logger.error(`❌ Erro ao carregar configuração da instância ${instanceId}:`, error);
      return null;
    }
  }

  /**
   * Obtém todas as configurações de instâncias
   */
  public async getAllInstanceConfigs(): Promise<InstanceConfig[]> {
    try {
      const files = await fs.readdir(this.configsDir);
      const configs: InstanceConfig[] = [];
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const instanceId = file.replace('.json', '');
          const config = await this.getInstanceConfig(instanceId);
          
          if (config) {
            configs.push(config);
          }
        }
      }
      
      return configs;
      
    } catch (error) {
      Logger.error('❌ Erro ao carregar todas as configurações:', error);
      return [];
    }
  }

  /**
   * Salva estado de autenticação
   */
  public async saveAuthState(instanceId: string, authState: AuthState): Promise<void> {
    try {
      const sessionPath = join(this.sessionsDir, `${instanceId}.json`);
      
      const sessionData: SessionData = {
        instanceId,
        authState,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccess: new Date()
      };
      
      // Serializa buffers para base64
      const serializedData = this.serializeAuthState(sessionData);
      
      await fs.writeFile(sessionPath, JSON.stringify(serializedData, null, 2), 'utf8');
      
      // Atualiza cache
      this.sessionCache.set(instanceId, sessionData);
      
      Logger.info(`💾 Estado de autenticação salvo para instância: ${instanceId}`);
      
    } catch (error) {
      Logger.error(`❌ Erro ao salvar estado de autenticação da instância ${instanceId}:`, error);
      throw error;
    }
  }

  /**
   * Carrega estado de autenticação
   */
  public async getAuthState(instanceId: string): Promise<AuthState | null> {
    try {
      // Verifica cache primeiro
      if (this.sessionCache.has(instanceId)) {
        const cached = this.sessionCache.get(instanceId)!;
        cached.lastAccess = new Date();
        return cached.authState;
      }
      
      const sessionPath = join(this.sessionsDir, `${instanceId}.json`);
      
      try {
        const sessionData = await fs.readFile(sessionPath, 'utf8');
        const parsed = JSON.parse(sessionData);
        
        // Deserializa buffers
        const sessionObj = this.deserializeAuthState(parsed);
        
        // Atualiza cache
        sessionObj.lastAccess = new Date();
        this.sessionCache.set(instanceId, sessionObj);
        
        return sessionObj.authState;
      } catch (fileError) {
        if ((fileError as any).code === 'ENOENT') {
          return null; // Arquivo não existe
        }
        throw fileError;
      }
      
    } catch (error) {
      Logger.error(`❌ Erro ao carregar estado de autenticação da instância ${instanceId}:`, error);
      return null;
    }
  }

  /**
   * Atualiza credenciais específicas
   */
  public async updateCredentials(instanceId: string, creds: Partial<AuthState['creds']>): Promise<void> {
    try {
      let authState = await this.getAuthState(instanceId);
      
      if (!authState) {
        authState = { creds: {}, keys: {} };
      }
      
      authState.creds = { ...authState.creds, ...creds };
      
      await this.saveAuthState(instanceId, authState);
      
      Logger.info(`🔑 Credenciais atualizadas para instância: ${instanceId}`);
      
    } catch (error) {
      Logger.error(`❌ Erro ao atualizar credenciais da instância ${instanceId}:`, error);
      throw error;
    }
  }

  /**
   * Atualiza chaves específicas
   */
  public async updateKeys(instanceId: string, keys: Partial<AuthState['keys']>): Promise<void> {
    try {
      let authState = await this.getAuthState(instanceId);
      
      if (!authState) {
        authState = { creds: {}, keys: {} };
      }
      
      authState.keys = { ...authState.keys, ...keys };
      
      await this.saveAuthState(instanceId, authState);
      
      Logger.info(`🔐 Chaves atualizadas para instância: ${instanceId}`);
      
    } catch (error) {
      Logger.error(`❌ Erro ao atualizar chaves da instância ${instanceId}:`, error);
      throw error;
    }
  }

  /**
   * Remove dados de uma instância
   */
  public async removeInstanceData(instanceId: string): Promise<void> {
    try {
      const sessionPath = join(this.sessionsDir, `${instanceId}.json`);
      const configPath = join(this.configsDir, `${instanceId}.json`);
      
      // Remove arquivos
      try {
        await fs.unlink(sessionPath);
      } catch (error) {
        if ((error as any).code !== 'ENOENT') {
          throw error;
        }
      }
      
      try {
        await fs.unlink(configPath);
      } catch (error) {
        if ((error as any).code !== 'ENOENT') {
          throw error;
        }
      }
      
      // Remove do cache
      this.sessionCache.delete(instanceId);
      this.configCache.delete(instanceId);
      
      Logger.info(`🗑️ Dados removidos para instância: ${instanceId}`);
      
    } catch (error) {
      Logger.error(`❌ Erro ao remover dados da instância ${instanceId}:`, error);
      throw error;
    }
  }

  /**
   * Serializa estado de autenticação para JSON
   */
  private serializeAuthState(sessionData: SessionData): any {
    const serialized = JSON.parse(JSON.stringify(sessionData));
    
    // Converte Buffers para base64
    if (serialized.authState.creds) {
      Object.keys(serialized.authState.creds).forEach(key => {
        const value = serialized.authState.creds[key];
        if (Buffer.isBuffer(value)) {
          serialized.authState.creds[key] = {
            type: 'Buffer',
            data: value.toString('base64')
          };
        }
      });
    }
    
    if (serialized.authState.keys) {
      Object.keys(serialized.authState.keys).forEach(keyType => {
        const keyGroup = serialized.authState.keys[keyType];
        if (keyGroup && typeof keyGroup === 'object') {
          Object.keys(keyGroup).forEach(keyId => {
            const value = keyGroup[keyId];
            if (Buffer.isBuffer(value)) {
              keyGroup[keyId] = {
                type: 'Buffer',
                data: value.toString('base64')
              };
            }
          });
        }
      });
    }
    
    return serialized;
  }

  /**
   * Deserializa estado de autenticação do JSON
   */
  private deserializeAuthState(data: any): SessionData {
    const sessionData = { ...data };
    
    // Converte base64 de volta para Buffers
    if (sessionData.authState.creds) {
      Object.keys(sessionData.authState.creds).forEach(key => {
        const value = sessionData.authState.creds[key];
        if (value && value.type === 'Buffer' && value.data) {
          sessionData.authState.creds[key] = Buffer.from(value.data, 'base64');
        }
      });
    }
    
    if (sessionData.authState.keys) {
      Object.keys(sessionData.authState.keys).forEach(keyType => {
        const keyGroup = sessionData.authState.keys[keyType];
        if (keyGroup && typeof keyGroup === 'object') {
          Object.keys(keyGroup).forEach(keyId => {
            const value = keyGroup[keyId];
            if (value && value.type === 'Buffer' && value.data) {
              keyGroup[keyId] = Buffer.from(value.data, 'base64');
            }
          });
        }
      });
    }
    
    // Converte datas
    sessionData.createdAt = new Date(sessionData.createdAt);
    sessionData.updatedAt = new Date(sessionData.updatedAt);
    sessionData.lastAccess = new Date(sessionData.lastAccess);
    
    return sessionData;
  }

  /**
   * Limpa cache de sessões antigas
   */
  public cleanupCache(): void {
    const now = new Date();
    const maxAge = 24 * 60 * 60 * 1000; // 24 horas
    
    for (const [instanceId, sessionData] of this.sessionCache) {
      if (now.getTime() - sessionData.lastAccess.getTime() > maxAge) {
        this.sessionCache.delete(instanceId);
        Logger.info(`🧹 Cache de sessão limpo para instância: ${instanceId}`);
      }
    }
  }

  /**
   * Obtém estatísticas das sessões
   */
  public getStats(): {
    totalSessions: number;
    cachedSessions: number;
    totalConfigs: number;
    cachedConfigs: number;
  } {
    return {
      totalSessions: this.sessionCache.size,
      cachedSessions: this.sessionCache.size,
      totalConfigs: this.configCache.size,
      cachedConfigs: this.configCache.size
    };
  }
}