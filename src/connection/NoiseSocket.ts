import { EventEmitter } from 'events';
import { createCipheriv, createDecipheriv } from 'crypto';
import WebSocket from 'ws';

/**
 * Handler para frames recebidos
 */
export type FrameHandler = (frame: Buffer) => void;

/**
 * Handler para desconexão
 */
export type DisconnectHandler = (socket: NoiseSocket, remote: boolean) => void;

/**
 * Implementação do NoiseSocket baseada no whatsmeow
 * Gerencia comunicação criptografada via WebSocket
 */
export class NoiseSocket extends EventEmitter {
  private ws: WebSocket;
  private writeKey: Buffer;
  private readKey: Buffer;
  private writeCounter: number = 0;
  private readCounter: number = 0;
  private destroyed: boolean = false;
  private onFrame: FrameHandler;
  private onDisconnect: DisconnectHandler;

  constructor(
    ws: WebSocket,
    writeKey: Buffer,
    readKey: Buffer,
    frameHandler: FrameHandler,
    disconnectHandler: DisconnectHandler
  ) {
    super();
    
    this.ws = ws;
    this.writeKey = writeKey;
    this.readKey = readKey;
    this.onFrame = frameHandler;
    this.onDisconnect = disconnectHandler;

    this.setupWebSocketHandlers();
  }

  /**
   * Configura handlers do WebSocket
   */
  private setupWebSocketHandlers(): void {
    this.ws.on('message', (data: Buffer) => {
      this.receiveEncryptedFrame(data);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      if (!this.destroyed) {
        this.onDisconnect(this, true);
      }
    });

    this.ws.on('error', (error: Error) => {
      console.error('NoiseSocket WebSocket error:', error);
      if (!this.destroyed) {
        this.onDisconnect(this, true);
      }
    });
  }

  /**
   * Gera IV para criptografia baseado no contador
   * @param count - Valor do contador
   * @returns IV de 12 bytes
   */
  private generateIV(count: number): Buffer {
    const iv = Buffer.alloc(12);
    iv.writeUInt32BE(count, 8);
    return iv;
  }

  /**
   * Envia frame criptografado
   * @param plaintext - Dados em texto claro
   * @returns Promise que resolve quando enviado
   */
  async sendFrame(plaintext: Buffer): Promise<void> {
    if (this.destroyed || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Socket is not connected');
    }

    try {
      const iv = this.generateIV(this.writeCounter);
      const cipher = createCipheriv('aes-256-gcm', this.writeKey, iv);
      
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      const ciphertext = Buffer.concat([encrypted, tag]);
      
      this.writeCounter++;
      
      return new Promise((resolve, reject) => {
        this.ws.send(ciphertext, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    } catch (error) {
      throw new Error(`Failed to encrypt and send frame: ${error}`);
    }
  }

  /**
   * Processa frame criptografado recebido
   * @param ciphertext - Dados criptografados
   */
  private receiveEncryptedFrame(ciphertext: Buffer): void {
    try {
      const iv = this.generateIV(this.readCounter);
      const encrypted = ciphertext.slice(0, -16);
      const tag = ciphertext.slice(-16);
      
      const decipher = createDecipheriv('aes-256-gcm', this.readKey, iv);
      decipher.setAuthTag(tag);
      
      const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      this.readCounter++;
      
      this.onFrame(plaintext);
    } catch (error) {
      console.warn('Failed to decrypt frame:', error);
      // Não desconecta por erro de descriptografia, apenas ignora o frame
    }
  }

  /**
   * Verifica se o socket está conectado
   * @returns true se conectado
   */
  isConnected(): boolean {
    return !this.destroyed && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Para o socket e opcionalmente desconecta
   * @param disconnect - Se deve desconectar o WebSocket
   */
  stop(disconnect: boolean = true): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    
    if (disconnect && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'Normal closure');
    }

    this.removeAllListeners();
  }

  /**
   * Obtém estatísticas do socket
   * @returns Estatísticas de contadores
   */
  getStats(): { writeCounter: number; readCounter: number; isConnected: boolean } {
    return {
      writeCounter: this.writeCounter,
      readCounter: this.readCounter,
      isConnected: this.isConnected()
    };
  }


}