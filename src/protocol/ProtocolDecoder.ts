// ProtocolDecoder.ts - Decodificador de protocolo binário do WhatsApp Web

import { Logger } from '../utils/Logger';
import { PROTOCOL_DECODER_CONFIG } from '../constants/Constants';
import { WABinaryDecoder, BinaryNode } from './WABinary/decode';

/**
 * Tipos de mensagens do protocolo WhatsApp
 */
export enum MessageType {
  HANDSHAKE_SERVER_HELLO = 0,
  HANDSHAKE_CLIENT_HELLO = 1,
  HANDSHAKE_CLIENT_FINISH = 2,
  STREAM_START = 3,
  STREAM_END = 4,
  SUCCESS = 5,
  FAILURE = 6,
  CHALLENGE = 7,
  QR_CODE = 8,
  BINARY_MESSAGE = 9,
  JSON_MESSAGE = 10,
  SERVER_HELLO_26 = 26 // Tipo de mensagem Server Hello recebido
}

/**
 * Interface para mensagem decodificada
 */
export interface DecodedMessage {
  type: MessageType;
  tag?: string;
  data: Buffer;
  attributes?: { [key: string]: string };
  content?: any;
}

/**
 * Interface para dados do QR code
 */
export interface QRCodePayload {
  ref: string;
  publicKey: string;
  clientId: string;
  serverToken?: string;
  ttl?: number;
}

/**
 * Decodificador de protocolo binário do WhatsApp Web
 */
export class ProtocolDecoder {
  private static readonly FRAME_HEADER_SIZE = PROTOCOL_DECODER_CONFIG.FRAME_HEADER_SIZE;
  private static readonly MAX_FRAME_SIZE = PROTOCOL_DECODER_CONFIG.MAX_FRAME_SIZE;
  private static readonly WA_HEADER = PROTOCOL_DECODER_CONFIG.WA_HEADER;

  /**
   * Decodifica frame completo do WebSocket
   */
  public static async decodeFrame(buffer: Buffer): Promise<DecodedMessage | null> {
    try {
      // erro curtinho (4 bytes)
      if (buffer.length === 4) {
        Logger.error('Resposta de erro do servidor (4 bytes)', {
          bytes: buffer.toString('hex'),
          decimal: Array.from(buffer)
        });
        return {
          type: MessageType.FAILURE,
          data: buffer,
          content: { errorCode: buffer.readUInt32BE(0), reason: 'Server rejected handshake' }
        };
      }

      if (buffer.length < this.FRAME_HEADER_SIZE) {
        Logger.warn('Frame muito pequeno', { size: buffer.length });
        return null;
      }

      // suporte a header WA opcional
      let offset = 0;
      if (buffer.length >= 7 && buffer.slice(0, 4).equals(this.WA_HEADER)) {
        offset = 4; // pula header se presente
      }

      const frameLength = (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2];
      if (frameLength > this.MAX_FRAME_SIZE) {
        Logger.error('Frame muito grande', { size: frameLength }); return null;
      }
      if (buffer.length < offset + this.FRAME_HEADER_SIZE + frameLength) {
        Logger.warn('Frame incompleto', {
          expected: offset + this.FRAME_HEADER_SIZE + frameLength,
          received: buffer.length
        });
        return null;
      }

      const payload = buffer.slice(offset + this.FRAME_HEADER_SIZE, offset + this.FRAME_HEADER_SIZE + frameLength);
      Logger.binary('RECV', payload, `Frame de ${frameLength} bytes`);

      return await this.decodePayload(payload);

    } catch (error) {
      Logger.error('Erro ao decodificar frame', error);
      return null;
    }
  }

  /**
   * Decodifica payload da mensagem
   */
  private static async decodePayload(payload: Buffer): Promise<DecodedMessage | null> {
    try {
      if (payload.length === 0) return null;

      const messageType = payload[0];

      // Para ServerHello (26) e HandshakeServerHello (0), NÃO slice(1)
      if (messageType === MessageType.HANDSHAKE_SERVER_HELLO ||
        messageType === MessageType.SERVER_HELLO_26) {
        Logger.protocol('DECODE', `Tipo de mensagem: ${messageType}`, {
          type: MessageType[messageType] || 'UNKNOWN',
          dataLength: payload.length
        });
        return {
          type: messageType,
          data: payload.slice(1) // <- aqui podemos discutir, depende do framing
        };
      }

      const data = payload.slice(1);

      Logger.protocol('DECODE', `Tipo de mensagem: ${messageType}`, {
        type: MessageType[messageType] || 'UNKNOWN',
        dataLength: data.length
      });

      switch (messageType) {
        case MessageType.QR_CODE:
          return this.decodeQRCode(data);
        case MessageType.SUCCESS:
          return this.decodeSuccess(data);
        case MessageType.FAILURE:
          return this.decodeFailure(data);
        case MessageType.CHALLENGE:
          return this.decodeChallenge(data);
        case MessageType.BINARY_MESSAGE:
          return await this.decodeBinaryMessage(data);
        case MessageType.JSON_MESSAGE:
          return this.decodeJSONMessage(data);
        default:
          Logger.warn('Tipo de mensagem desconhecido', { type: messageType });
          return { type: messageType, data };
      }
    } catch (error) {
      Logger.error('Erro ao decodificar payload', error);
      return null;
    }
  }


  /**
   * Decodifica Server Hello do handshake
   */
  private static decodeServerHello(payload: Buffer): DecodedMessage {
    Logger.handshake('SERVER_HELLO', 'Recebido Server Hello', { size: payload.length });

    // Já removemos o tipo em decodePayload, aqui o payload começa em 0x1a (tag do field serverHello)
    let offset = 0;
    const tag = payload[offset++]; // deve ser 0x1a
    if (tag !== 0x1a) {
      Logger.warn('ServerHello: tag inesperada', { tag });
    }

    // Lê length (varint)
    let shift = 0, len = 0;
    while (true) {
      const b = payload[offset++];
      len |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }

    const serverHello = payload.slice(offset, offset + len);

    return {
      type: MessageType.HANDSHAKE_SERVER_HELLO,
      data: serverHello // <- passa só o conteúdo real do serverHello
    };
  }



  /**
   * Decodifica dados do QR code
   */
  private static decodeQRCode(data: Buffer): DecodedMessage {
    try {
      Logger.qrcode('Decodificando dados do QR code', { size: data.length });

      // Tenta decodificar como JSON primeiro
      let qrPayload: QRCodePayload;

      try {
        const jsonStr = data.toString('utf8');
        const parsed = JSON.parse(jsonStr);
        qrPayload = {
          ref: parsed.ref || '',
          publicKey: parsed.publicKey || '',
          clientId: parsed.clientId || '',
          serverToken: parsed.serverToken,
          ttl: parsed.ttl
        };
      } catch {
        // Se não for JSON, tenta formato binário
        qrPayload = this.decodeBinaryQRData(data);
      }

      Logger.qrcode('QR code decodificado', qrPayload);

      return {
        type: MessageType.QR_CODE,
        data: data,
        content: qrPayload
      };

    } catch (error) {
      Logger.error('Erro ao decodificar QR code', error);
      return {
        type: MessageType.QR_CODE,
        data: data
      };
    }
  }

  /**
   * Decodifica QR code em formato binário
   */
  private static decodeBinaryQRData(data: Buffer): QRCodePayload {
    // Formato binário típico do WhatsApp:
    // - 4 bytes: length do ref
    // - N bytes: ref
    // - 4 bytes: length da publicKey
    // - N bytes: publicKey
    // - 4 bytes: length do clientId
    // - N bytes: clientId

    let offset = 0;

    // Lê ref
    const refLength = data.readUInt32BE(offset);
    offset += 4;
    const ref = data.slice(offset, offset + refLength).toString('utf8');
    offset += refLength;

    // Lê publicKey
    const publicKeyLength = data.readUInt32BE(offset);
    offset += 4;
    const publicKey = data.slice(offset, offset + publicKeyLength).toString('base64');
    offset += publicKeyLength;

    // Lê clientId (se disponível)
    let clientId = '';
    if (offset < data.length) {
      const clientIdLength = data.readUInt32BE(offset);
      offset += 4;
      clientId = data.slice(offset, offset + clientIdLength).toString('utf8');
    }

    return {
      ref,
      publicKey,
      clientId
    };
  }

  /**
   * Decodifica mensagem de sucesso
   */
  private static decodeSuccess(data: Buffer): DecodedMessage {
    Logger.connection('SUCCESS', 'Operação bem-sucedida', { size: data.length });

    return {
      type: MessageType.SUCCESS,
      data: data,
      content: {
        message: data.toString('utf8')
      }
    };
  }

  /**
   * Decodifica mensagem de falha
   */
  private static decodeFailure(data: Buffer): DecodedMessage {
    Logger.connection('FAILURE', 'Operação falhou', { size: data.length });

    return {
      type: MessageType.FAILURE,
      data: data,
      content: {
        error: data.toString('utf8')
      }
    };
  }

  /**
   * Decodifica challenge de autenticação
   */
  private static decodeChallenge(data: Buffer): DecodedMessage {
    Logger.crypto('CHALLENGE', 'Recebido challenge', { size: data.length });

    return {
      type: MessageType.CHALLENGE,
      data: data,
      content: {
        challenge: data
      }
    };
  }

  /**
   * Decodifica mensagem binária usando WABinary
   */
  private static async decodeBinaryMessage(data: Buffer): Promise<DecodedMessage> {
    Logger.protocol('BINARY_MSG', 'Mensagem binária recebida', { size: data.length });

    try {
      // Usa WABinaryDecoder para decodificar mensagens binárias
      const binaryNode = await WABinaryDecoder.decode(data);
      
      if (binaryNode) {
        Logger.protocol('WABinary decodificado', binaryNode.tag, {
          attrs: binaryNode.attrs,
          hasContent: !!binaryNode.content
        });
        
        return {
          type: MessageType.BINARY_MESSAGE,
          tag: binaryNode.tag,
          data: data,
          attributes: binaryNode.attrs,
          content: binaryNode
        };
      }
    } catch (error) {
      Logger.error('Erro ao decodificar WABinary', error);
    }

    // Fallback para decodificação raw se WABinary falhar
    return {
      type: MessageType.BINARY_MESSAGE,
      data: data
    };
  }

  /**
   * Decodifica mensagem JSON
   */
  private static decodeJSONMessage(data: Buffer): DecodedMessage {
    try {
      const jsonStr = data.toString('utf8');
      const content = JSON.parse(jsonStr);

      Logger.protocol('JSON_MSG', 'Mensagem JSON recebida', content);

      return {
        type: MessageType.JSON_MESSAGE,
        data: data,
        content: content
      };

    } catch (error) {
      Logger.error('Erro ao decodificar JSON', error);
      return {
        type: MessageType.JSON_MESSAGE,
        data: data
      };
    }
  }

  /**
   * Codifica mensagem para envio
   */
  public static encodeMessage(type: MessageType, payload: Buffer): Buffer {
    const messageType = Buffer.from([type]);
    const message = Buffer.concat([messageType, payload]);

    // Adiciona header do frame (3 bytes com o tamanho)
    const frameLength = message.length;
    const header = Buffer.alloc(3);
    header[0] = (frameLength >> 16) & 0xFF;
    header[1] = (frameLength >> 8) & 0xFF;
    header[2] = frameLength & 0xFF;

    const frame = Buffer.concat([header, message]);

    Logger.binary('SEND', frame, `Frame de ${frameLength} bytes`);

    return frame;
  }

  /**
   * Codifica Client Hello para handshake
   */
  public static encodeClientHello(clientPublicKey: Buffer, clientEphemeral: Buffer): Buffer {
    const payload = Buffer.concat([clientPublicKey, clientEphemeral]);
    return this.encodeMessage(MessageType.HANDSHAKE_CLIENT_HELLO, payload);
  }

  /**
   * Codifica Client Finish para handshake
   */
  public static encodeClientFinish(encryptedPayload: Buffer): Buffer {
    return this.encodeMessage(MessageType.HANDSHAKE_CLIENT_FINISH, encryptedPayload);
  }

  /**
   * Valida integridade do frame
   */
  public static validateFrame(buffer: Buffer): boolean {
    if (buffer.length < this.FRAME_HEADER_SIZE) {
      return false;
    }

    const frameLength = (buffer[0] << 16) | (buffer[1] << 8) | buffer[2];

    return frameLength <= this.MAX_FRAME_SIZE &&
      buffer.length >= this.FRAME_HEADER_SIZE + frameLength;
  }

  /**
   * Extrai múltiplos frames de um buffer
   */
  public static extractFrames(buffer: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    let offset = 0;

    while (offset < buffer.length) {
      if (offset + this.FRAME_HEADER_SIZE > buffer.length) {
        break; // Header incompleto
      }

      const frameLength = (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2];
      const totalFrameSize = this.FRAME_HEADER_SIZE + frameLength;

      if (offset + totalFrameSize > buffer.length) {
        break; // Frame incompleto
      }

      const frame = buffer.slice(offset, offset + totalFrameSize);
      frames.push(frame);
      offset += totalFrameSize;
    }

    return frames;
  }
}