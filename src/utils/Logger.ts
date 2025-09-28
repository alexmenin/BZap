// Logger.ts - Sistema de logs para debug do protocolo WhatsApp Web

/**
 * Níveis de log disponíveis
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4
}

/**
 * Interface para configuração do logger
 */
export interface LoggerConfig {
  level: LogLevel;
  enableColors: boolean;
  enableTimestamp: boolean;
  enableBinaryDump: boolean;
  maxBinaryLength: number;
}

/**
 * Sistema de logs otimizado para debug do protocolo WhatsApp
 */
export class Logger {
  private static config: LoggerConfig = {
    level: LogLevel.INFO,
    enableColors: true,
    enableTimestamp: true,
    enableBinaryDump: true,
    maxBinaryLength: 256
  };

  private static colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m'
  };

  /**
   * Configura o logger
   */
  public static configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Log de debug
   */
  public static debug(message: string, data?: any): void {
    if (this.config.level <= LogLevel.DEBUG) {
      this.log('DEBUG', message, data, this.colors.gray);
    }
  }

  /**
   * Log de informação
   */
  public static info(message: string, data?: any): void {
    if (this.config.level <= LogLevel.INFO) {
      this.log('INFO', message, data, this.colors.blue);
    }
  }

  /**
   * Log de aviso
   */
  public static warn(message: string, data?: any): void {
    if (this.config.level <= LogLevel.WARN) {
      this.log('WARN', message, data, this.colors.yellow);
    }
  }

  /**
   * Log de erro
   */
  public static error(message: string, error?: any): void {
    if (this.config.level <= LogLevel.ERROR) {
      this.log('ERROR', message, error, this.colors.red);
    }
  }

  /**
   * Log específico para WebSocket
   */
  public static websocket(direction: 'SEND' | 'RECV', message: string, data?: any): void {
    const arrow = direction === 'SEND' ? '→' : '←';
    const color = direction === 'SEND' ? this.colors.green : this.colors.cyan;
    this.log(`WS ${arrow}`, message, data, color);
  }

  /**
   * Log específico para handshake
   */
  public static handshake(step: string, message: string, data?: any): void {
    this.log(`🤝 ${step}`, message, data, this.colors.magenta);
  }

  /**
   * Log específico para criptografia
   */
  public static crypto(operation: string, message: string, data?: any): void {
    this.log(`🔐 ${operation}`, message, data, this.colors.yellow);
  }

  /**
   * Log de dados binários
   */
  public static binary(direction: 'SEND' | 'RECV', data: Buffer | Uint8Array, description?: string): void {
    if (!this.config.enableBinaryDump) return;
    
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const arrow = direction === 'SEND' ? '→' : '←';
    const color = direction === 'SEND' ? this.colors.green : this.colors.cyan;
    
    let message = `BINARY ${arrow} ${buffer.length} bytes`;
    if (description) {
      message += ` (${description})`;
    }
    
    this.log('BIN', message, null, color);
    
    // Exibe hex dump dos primeiros bytes
    const maxLength = Math.min(buffer.length, this.config.maxBinaryLength);
    const hexDump = this.formatHexDump(buffer.slice(0, maxLength));
    
    if (this.config.enableColors) {
      console.log(`${this.colors.dim}${hexDump}${this.colors.reset}`);
    } else {
      console.log(hexDump);
    }
    
    if (buffer.length > maxLength) {
      console.log(`${this.colors.dim}... (${buffer.length - maxLength} bytes restantes)${this.colors.reset}`);
    }
  }

  /**
   * Log de protocolo com estrutura
   */
  public static protocol(type: string, message: string, payload?: any): void {
    this.log(`📡 ${type}`, message, payload, this.colors.cyan);
  }

  /**
   * Log de QR code
   */
  public static qrcode(message: string, data?: any): void {
    this.log('📱 QR', message, data, this.colors.magenta);
  }

  /**
   * Log de conexão
   */
  public static connection(status: string, message: string, data?: any): void {
    const emoji = this.getConnectionEmoji(status);
    this.log(`${emoji} ${status}`, message, data, this.colors.blue);
  }

  /**
   * Método principal de log
   */
  private static log(level: string, message: string, data?: any, color?: string): void {
    let output = '';
    
    // Timestamp
    if (this.config.enableTimestamp) {
      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, -5);
      output += `[${timestamp}] `;
    }
    
    // Level com cor
    if (this.config.enableColors && color) {
      output += `${color}[${level.padEnd(8)}]${this.colors.reset} `;
    } else {
      output += `[${level.padEnd(8)}] `;
    }
    
    // Mensagem
    output += message;
    
    console.log(output);
    
    // Dados adicionais
    if (data !== undefined && data !== null) {
      if (typeof data === 'object') {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(data);
      }
    }
  }

  /**
   * Formata hex dump de dados binários
   */
  private static formatHexDump(buffer: Buffer): string {
    const lines: string[] = [];
    const bytesPerLine = 16;
    
    for (let i = 0; i < buffer.length; i += bytesPerLine) {
      const chunk = buffer.slice(i, i + bytesPerLine);
      const offset = i.toString(16).padStart(8, '0');
      const hex = chunk.toString('hex').match(/.{1,2}/g)?.join(' ') || '';
      const ascii = chunk.toString('ascii').replace(/[^\x20-\x7E]/g, '.');
      
      lines.push(`  ${offset}  ${hex.padEnd(47)} |${ascii}|`);
    }
    
    return lines.join('\n');
  }

  /**
   * Obtém emoji para status de conexão
   */
  private static getConnectionEmoji(status: string): string {
    const emojiMap: { [key: string]: string } = {
      'CONNECTING': '🔄',
      'CONNECTED': '✅',
      'DISCONNECTED': '❌',
      'RECONNECTING': '🔄',
      'ERROR': '💥',
      'TIMEOUT': '⏰'
    };
    
    return emojiMap[status.toUpperCase()] || '📡';
  }

  /**
   * Cria separador visual
   */
  public static separator(title?: string): void {
    const line = '='.repeat(60);
    if (title) {
      const padding = Math.max(0, (60 - title.length - 2) / 2);
      const paddedTitle = ' '.repeat(Math.floor(padding)) + title + ' '.repeat(Math.ceil(padding));
      console.log(`\n${line}`);
      console.log(paddedTitle);
      console.log(line);
    } else {
      console.log(line);
    }
  }

  /**
   * Log de performance
   */
  public static performance(operation: string, startTime: number, endTime?: number): void {
    const duration = (endTime || Date.now()) - startTime;
    this.debug(`⚡ ${operation} executado em ${duration}ms`);
  }

  /**
   * Log de estatísticas
   */
  public static stats(title: string, stats: { [key: string]: any }): void {
    this.info(`📊 ${title}`);
    Object.entries(stats).forEach(([key, value]) => {
      console.log(`  ${key}: ${value}`);
    });
  }

  /**
   * Habilita modo verbose (debug)
   */
  public static enableVerbose(): void {
    this.config.level = LogLevel.DEBUG;
    this.info('Modo verbose habilitado');
  }

  /**
   * Desabilita logs
   */
  public static disable(): void {
    this.config.level = LogLevel.NONE;
  }

  /**
   * Obtém configuração atual
   */
  public static getConfig(): LoggerConfig {
    return { ...this.config };
  }
}