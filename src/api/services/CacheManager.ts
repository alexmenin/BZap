// services/CacheManager.ts - Gerenciador de cache

import { EventEmitter } from 'events';
import { Logger } from '../../utils/Logger';

/**
 * Interface para item de cache
 */
interface CacheItem<T = any> {
  value: T;
  expiresAt?: Date;
  createdAt: Date;
  accessCount: number;
  lastAccess: Date;
}

/**
 * Interface para configuração de cache
 */
interface CacheConfig {
  maxSize?: number;
  defaultTTL?: number; // Time to live em milissegundos
  cleanupInterval?: number;
}

/**
 * Interface para estatísticas de cache
 */
interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
  memoryUsage: number;
}

/**
 * Gerenciador de cache
 * Implementa cache em memória com TTL e limpeza automática
 */
export class CacheManager extends EventEmitter {
  private static instance: CacheManager;
  
  // Caches específicos
  private messageCache: Map<string, CacheItem> = new Map();
  private qrCodeCache: Map<string, CacheItem> = new Map();
  private userDevicesCache: Map<string, CacheItem> = new Map();
  private groupMetadataCache: Map<string, CacheItem> = new Map();
  private msgRetryCounterCache: Map<string, CacheItem> = new Map();
  private presenceCache: Map<string, CacheItem> = new Map();
  private contactCache: Map<string, CacheItem> = new Map();
  
  // Estatísticas
  private stats = {
    hits: 0,
    misses: 0
  };
  
  // Configuração
  private config: Required<CacheConfig>;
  
  // Timer de limpeza
  private cleanupTimer?: NodeJS.Timeout;

  private constructor(config: CacheConfig = {}) {
    super();
    
    this.config = {
      maxSize: config.maxSize ?? 10000,
      defaultTTL: config.defaultTTL ?? 30 * 60 * 1000, // 30 minutos
      cleanupInterval: config.cleanupInterval ?? 5 * 60 * 1000 // 5 minutos
    };
    
    this.startCleanupTimer();
    
    Logger.info('🗄️ CacheManager inicializado');
  }

  /**
   * Obtém a instância singleton
   */
  public static getInstance(config?: CacheConfig): CacheManager {
    if (!CacheManager.instance) {
      CacheManager.instance = new CacheManager(config);
    }
    return CacheManager.instance;
  }

  /**
   * Define um item no cache
   */
  private setItem<T>(
    cache: Map<string, CacheItem>,
    key: string,
    value: T,
    ttl?: number
  ): void {
    const now = new Date();
    const expiresAt = ttl ? new Date(now.getTime() + ttl) : undefined;
    
    const item: CacheItem<T> = {
      value,
      expiresAt,
      createdAt: now,
      accessCount: 0,
      lastAccess: now
    };
    
    cache.set(key, item);
    
    // Verifica limite de tamanho
    if (cache.size > this.config.maxSize) {
      this.evictLRU(cache);
    }
  }

  /**
   * Obtém um item do cache
   */
  private getItem<T>(cache: Map<string, CacheItem>, key: string): T | null {
    const item = cache.get(key);
    
    if (!item) {
      this.stats.misses++;
      return null;
    }
    
    // Verifica expiração
    if (item.expiresAt && new Date() > item.expiresAt) {
      cache.delete(key);
      this.stats.misses++;
      return null;
    }
    
    // Atualiza estatísticas de acesso
    item.accessCount++;
    item.lastAccess = new Date();
    this.stats.hits++;
    
    return item.value as T;
  }

  /**
   * Remove item menos recentemente usado (LRU)
   */
  private evictLRU(cache: Map<string, CacheItem>): void {
    let oldestKey: string | null = null;
    let oldestTime = new Date();
    
    for (const [key, item] of cache) {
      if (item.lastAccess < oldestTime) {
        oldestTime = item.lastAccess;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      cache.delete(oldestKey);
      Logger.debug(`🧹 Item removido do cache (LRU): ${oldestKey}`);
    }
  }

  // ===== MÉTODOS PARA MENSAGENS =====

  /**
   * Armazena mensagem no cache
   */
  public setMessage(instanceId: string, messageId: string, message: any, ttl?: number): void {
    const key = `${instanceId}:${messageId}`;
    this.setItem(this.messageCache, key, message, ttl || this.config.defaultTTL);
    
    Logger.debug(`💬 Mensagem armazenada no cache: ${key}`);
  }

  /**
   * Obtém mensagem do cache
   */
  public getMessage(instanceId: string, messageId: string): any | null {
    const key = `${instanceId}:${messageId}`;
    return this.getItem(this.messageCache, key);
  }

  /**
   * Remove mensagem do cache
   */
  public removeMessage(instanceId: string, messageId: string): boolean {
    const key = `${instanceId}:${messageId}`;
    return this.messageCache.delete(key);
  }

  // ===== MÉTODOS PARA QR CODE =====

  /**
   * Armazena QR code no cache
   */
  public async setQRCode(instanceId: string, qrCode: string, expiresAt?: Date): Promise<void> {
    const ttl = expiresAt ? expiresAt.getTime() - Date.now() : 60000; // 1 minuto padrão
    this.setItem(this.qrCodeCache, instanceId, qrCode, ttl);
    
    Logger.debug(`📱 QR code armazenado no cache: ${instanceId}`);
  }

  /**
   * Obtém QR code do cache
   */
  public getQRCode(instanceId: string): string | null {
    return this.getItem(this.qrCodeCache, instanceId);
  }

  /**
   * Remove QR code do cache
   */
  public async clearQRCode(instanceId: string): Promise<void> {
    this.qrCodeCache.delete(instanceId);
    Logger.debug(`📱 QR code removido do cache: ${instanceId}`);
  }

  // ===== MÉTODOS PARA DISPOSITIVOS DE USUÁRIO =====

  /**
   * Armazena dispositivos de usuário
   */
  public setUserDevices(instanceId: string, jid: string, devices: any[], ttl?: number): void {
    const key = `${instanceId}:${jid}`;
    this.setItem(this.userDevicesCache, key, devices, ttl || this.config.defaultTTL);
    
    Logger.debug(`📱 Dispositivos de usuário armazenados: ${key}`);
  }

  /**
   * Obtém dispositivos de usuário
   */
  public getUserDevices(instanceId: string, jid: string): any[] | null {
    const key = `${instanceId}:${jid}`;
    return this.getItem(this.userDevicesCache, key);
  }

  // ===== MÉTODOS PARA METADADOS DE GRUPO =====

  /**
   * Armazena metadados de grupo
   */
  public setGroupMetadata(instanceId: string, groupId: string, metadata: any, ttl?: number): void {
    const key = `${instanceId}:${groupId}`;
    this.setItem(this.groupMetadataCache, key, metadata, ttl || this.config.defaultTTL);
    
    Logger.debug(`👥 Metadados de grupo armazenados: ${key}`);
  }

  /**
   * Obtém metadados de grupo
   */
  public getGroupMetadata(instanceId: string, groupId: string): any | null {
    const key = `${instanceId}:${groupId}`;
    return this.getItem(this.groupMetadataCache, key);
  }

  // ===== MÉTODOS PARA CONTADOR DE RETRY DE MENSAGENS =====

  /**
   * Incrementa contador de retry de mensagem
   */
  public incrementMsgRetryCounter(instanceId: string, messageId: string): number {
    const key = `${instanceId}:${messageId}`;
    const current = Number(this.getItem(this.msgRetryCounterCache, key)) || 0;
    const newCount = current + 1;
    
    this.setItem(this.msgRetryCounterCache, key, newCount, 24 * 60 * 60 * 1000); // 24 horas
    
    return newCount;
  }

  /**
   * Obtém contador de retry de mensagem
   */
  public getMsgRetryCounter(instanceId: string, messageId: string): number {
    const key = `${instanceId}:${messageId}`;
    return this.getItem(this.msgRetryCounterCache, key) || 0;
  }

  // ===== MÉTODOS PARA PRESENÇA =====

  /**
   * Armazena presença de usuário
   */
  public setPresence(instanceId: string, jid: string, presence: any, ttl?: number): void {
    const key = `${instanceId}:${jid}`;
    this.setItem(this.presenceCache, key, presence, ttl || 5 * 60 * 1000); // 5 minutos
    
    Logger.debug(`👤 Presença armazenada: ${key}`);
  }

  /**
   * Obtém presença de usuário
   */
  public getPresence(instanceId: string, jid: string): any | null {
    const key = `${instanceId}:${jid}`;
    return this.getItem(this.presenceCache, key);
  }

  // ===== MÉTODOS PARA CONTATOS =====

  /**
   * Armazena contato
   */
  public setContact(instanceId: string, jid: string, contact: any, ttl?: number): void {
    const key = `${instanceId}:${jid}`;
    this.setItem(this.contactCache, key, contact, ttl || this.config.defaultTTL);
    
    Logger.debug(`👤 Contato armazenado: ${key}`);
  }

  /**
   * Obtém contato
   */
  public getContact(instanceId: string, jid: string): any | null {
    const key = `${instanceId}:${jid}`;
    return this.getItem(this.contactCache, key);
  }

  // ===== MÉTODOS GERAIS =====

  /**
   * Limpa cache de uma instância específica
   */
  public async clearInstanceCache(instanceId: string): Promise<void> {
    const caches = [
      this.messageCache,
      this.qrCodeCache,
      this.userDevicesCache,
      this.groupMetadataCache,
      this.msgRetryCounterCache,
      this.presenceCache,
      this.contactCache
    ];
    
    let removedCount = 0;
    
    for (const cache of caches) {
      for (const key of cache.keys()) {
        if (key.startsWith(`${instanceId}:`)) {
          cache.delete(key);
          removedCount++;
        }
      }
    }
    
    Logger.info(`🧹 Cache limpo para instância ${instanceId}: ${removedCount} itens removidos`);
  }

  /**
   * Limpa itens expirados de todos os caches
   */
  public cleanup(): void {
    const now = new Date();
    const caches = [
      { name: 'messages', cache: this.messageCache },
      { name: 'qrCodes', cache: this.qrCodeCache },
      { name: 'userDevices', cache: this.userDevicesCache },
      { name: 'groupMetadata', cache: this.groupMetadataCache },
      { name: 'msgRetryCounter', cache: this.msgRetryCounterCache },
      { name: 'presence', cache: this.presenceCache },
      { name: 'contacts', cache: this.contactCache }
    ];
    
    let totalRemoved = 0;
    
    for (const { name, cache } of caches) {
      let removed = 0;
      
      for (const [key, item] of cache) {
        if (item.expiresAt && now > item.expiresAt) {
          cache.delete(key);
          removed++;
          totalRemoved++;
        }
      }
      
      if (removed > 0) {
        Logger.debug(`🧹 Cache ${name}: ${removed} itens expirados removidos`);
      }
    }
    
    if (totalRemoved > 0) {
      Logger.info(`🧹 Limpeza de cache concluída: ${totalRemoved} itens removidos`);
    }
  }

  /**
   * Inicia timer de limpeza automática
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
    
    Logger.info(`⏰ Timer de limpeza iniciado: ${this.config.cleanupInterval}ms`);
  }

  /**
   * Para timer de limpeza
   */
  public stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
      Logger.info('⏰ Timer de limpeza parado');
    }
  }

  /**
   * Obtém estatísticas do cache
   */
  public getStats(): CacheStats {
    const totalSize = 
      this.messageCache.size +
      this.qrCodeCache.size +
      this.userDevicesCache.size +
      this.groupMetadataCache.size +
      this.msgRetryCounterCache.size +
      this.presenceCache.size +
      this.contactCache.size;
    
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 ? (this.stats.hits / totalRequests) * 100 : 0;
    
    return {
      size: totalSize,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: Math.round(hitRate * 100) / 100,
      memoryUsage: process.memoryUsage().heapUsed
    };
  }

  /**
   * Reseta estatísticas
   */
  public resetStats(): void {
    this.stats.hits = 0;
    this.stats.misses = 0;
    Logger.info('📊 Estatísticas de cache resetadas');
  }

  /**
   * Limpa todos os caches
   */
  public clearAll(): void {
    this.messageCache.clear();
    this.qrCodeCache.clear();
    this.userDevicesCache.clear();
    this.groupMetadataCache.clear();
    this.msgRetryCounterCache.clear();
    this.presenceCache.clear();
    this.contactCache.clear();
    
    this.resetStats();
    
    Logger.info('🧹 Todos os caches limpos');
  }

  /**
   * Cleanup ao destruir instância
   */
  public destroy(): void {
    this.stopCleanupTimer();
    this.clearAll();
    this.removeAllListeners();
    
    Logger.info('💥 CacheManager destruído');
  }
}