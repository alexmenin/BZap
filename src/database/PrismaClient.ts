// PrismaClient.ts - Cliente Prisma centralizado

import { PrismaClient, Prisma } from '@prisma/client';
import { Logger } from '../utils/Logger';

/**
 * Cliente Prisma singleton para toda a aplicação
 */
class DatabaseClient {
  private static instance: PrismaClient | null = null;
  
  /**
   * Obtém a instância do Prisma Client
   */
  public static getInstance(): PrismaClient {
    if (!DatabaseClient.instance) {
      DatabaseClient.instance = new PrismaClient({
        log: [
          { level: 'query', emit: 'event' },
          { level: 'error', emit: 'stdout' },
          { level: 'info', emit: 'stdout' },
          { level: 'warn', emit: 'stdout' },
        ],
      }) as PrismaClient<Prisma.PrismaClientOptions, 'query'>;
      
      // Log das queries em desenvolvimento
      if (process.env.NODE_ENV === 'development') {
        (DatabaseClient.instance as any).$on('query', (e: Prisma.QueryEvent) => {
          Logger.debug(`🔍 Query: ${e.query}`);
          Logger.debug(`📊 Params: ${e.params}`);
          Logger.debug(`⏱️ Duration: ${e.duration}ms`);
        });
      }
      
      Logger.info('🗄️ Prisma Client inicializado');
    }
    
    return DatabaseClient.instance;
  }
  
  /**
   * Desconecta o cliente Prisma
   */
  public static async disconnect(): Promise<void> {
    if (DatabaseClient.instance) {
      await DatabaseClient.instance.$disconnect();
      DatabaseClient.instance = null;
      Logger.info('🔌 Prisma Client desconectado');
    }
  }
  
  /**
   * Testa a conexão com o banco
   */
  public static async testConnection(): Promise<boolean> {
    try {
      const client = DatabaseClient.getInstance();
      await client.$queryRaw`SELECT 1`;
      Logger.info('✅ Conexão com PostgreSQL estabelecida');
      return true;
    } catch (error) {
      Logger.error('❌ Erro ao conectar com PostgreSQL:', error);
      return false;
    }
  }
}

export { DatabaseClient };
export const prisma = DatabaseClient.getInstance();