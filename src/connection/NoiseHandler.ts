import { Boom } from '@hapi/boom';
import { KeyPair } from '../crypto/KeyManager';
import { BinaryNode } from '../protocol/WABinary/decode';
import { aesDecryptGCM, aesEncryptGCM, Curve, hkdf, sha256 } from '../crypto/Curve25519';
import { Logger } from '../utils/Logger';
import { NOISE_CONFIG } from '../constants/Constants';
import { decodeBinaryNode } from '../protocol/WABinary/decode';
import { waproto } from '@wppconnect/wa-proto';

// Constantes do protocolo Noise - alinhado com Baileys-master
const NOISE_MODE = NOISE_CONFIG.mode;
const WA_CERT_DETAILS = {
  SERIAL: 0
}; // Alinhado com Baileys-master

const generateIV = (counter: number) => {
  const iv = new ArrayBuffer(12);
  new DataView(iv).setUint32(8, counter, false); // false = big-endian
  return new Uint8Array(iv);
};

export interface NoiseHandlerOptions {
  keyPair: KeyPair;
  NOISE_HEADER: Uint8Array;
  logger: Logger;
  routingInfo?: Buffer;
}

// Usando tipos do @wppconnect/wa-proto
export type HandshakeMessage = waproto.IHandshakeMessage;

export interface CertChain {
  intermediate?: {
    details?: Buffer;
  };
}



/**
 * Implementação do NoiseHandler baseada no Baileys-master
 * Gerencia o protocolo Noise_XX_25519_AESGCM_SHA256
 */
export function makeNoiseHandler(options: NoiseHandlerOptions) {
  const { keyPair, logger, routingInfo } = options;
  const { private: privateKey, public: publicKey } = keyPair;

  const authenticate = (data: Uint8Array) => {
    if (!isFinished) {
      hash = sha256(Buffer.concat([hash, data]));
    }
  };

  const localHKDF = async (data: Uint8Array) => {
    const key = await hkdf(Buffer.from(data), 64, { salt, info: '' });
    return [key.slice(0, 32), key.slice(32)];
  };

  const mixIntoKey = async (data: Uint8Array) => {
    const [write, read] = await localHKDF(data);
    salt = write!;
    encKey = read!;
    decKey = read!;
    readCounter = 0;
    writeCounter = 0;
  };

  const generateIV = (counter: number) => {
    const iv = new ArrayBuffer(12);
    new DataView(iv).setUint32(8, counter); // padrão = big-endian
    return new Uint8Array(iv);
  };

  const encrypt = (plaintext: Uint8Array) => {
    const result = aesEncryptGCM(plaintext, encKey, generateIV(writeCounter), hash);
    writeCounter += 1;
    authenticate(result);
    return result;
  };

  const decrypt = (ciphertext: Uint8Array) => {
    // before the handshake is finished, we use the same counter
    // after handshake, the counters are different
    const counter = isFinished ? readCounter : writeCounter;
    const iv = generateIV(counter);
    
    // Descriptografia usando AES-GCM
    
    try {
      const result = aesDecryptGCM(ciphertext, decKey, iv, hash);
      // Descriptografia bem-sucedida

      // Incrementa o contador APÓS a descriptografia (como no Baileys-master)
      if (isFinished) {
        readCounter += 1;
      } else {
        writeCounter += 1;
      }
      
      // Chama authenticate APÓS a descriptografia (como no Baileys-master)
      authenticate(ciphertext);
      return result;
    } catch (error) {
      console.error('❌ [DECRYPT ERROR] Falha na descriptografia:', (error as Error).message);
      throw error;
    }
  };

  const finishInit = async () => {
    const [write, read] = await localHKDF(new Uint8Array(0));
    encKey = write!;
    decKey = read!;
    hash = Buffer.from([]);
    readCounter = 0;
    writeCounter = 0;
    isFinished = true;
  };

  // Inicialização do estado
  const data = Buffer.from(NOISE_MODE);
  let hash = data.byteLength === 32 ? data : sha256(data);
  let salt = hash;
  let encKey = hash;
  let decKey = hash;
  let readCounter = 0;
  let writeCounter = 0;
  let isFinished = false;
  let sentIntro = false;

  let inBytes = Buffer.alloc(0);

  // Autentica header e chave pública APÓS inicialização das variáveis
  authenticate(options.NOISE_HEADER);
  authenticate(publicKey);

  return {
    encrypt,
    decrypt,
    authenticate,
    mixIntoKey,
    finishInit,
    
    createClientHello: async () => {
      console.log('🔐 Criando ClientHello usando protobuf...');
      
      try {
        // Cria a estrutura ClientHello seguindo o padrão do Baileys
        const clientHelloData = {
          clientHello: {
            ephemeral: publicKey
          }
        };
        
        // Codifica usando protobuf do @wppconnect/wa-proto
         const encoded = waproto.HandshakeMessage.encode(clientHelloData).finish();
        
        // NÃO chame authenticate(publicKey) aqui; já foi chamado na inicialização
        
        return Buffer.from(encoded);
        
      } catch (error) {
        console.error('❌ Erro ao criar ClientHello protobuf:', error);
        // Removido fallback que duplicava o header WA e alterava o hash
        throw error;
      }
    },
    
    processHandshake: async ({ serverHello }: HandshakeMessage, noiseKey: KeyPair) => {
      if (!serverHello?.ephemeral || !serverHello?.static || !serverHello?.payload) {
        console.error('❌ [HANDSHAKE ERROR] ServerHello incompleto:', {
          hasEphemeral: !!serverHello?.ephemeral,
          hasStatic: !!serverHello?.static,
          hasPayload: !!serverHello?.payload
        });
        throw new Error('ServerHello incompleto');
      }

      authenticate(serverHello.ephemeral);
      await mixIntoKey(Curve.sharedKey(privateKey, serverHello.ephemeral));

      const decStaticContent = decrypt(serverHello.static);
      await mixIntoKey(Curve.sharedKey(privateKey, decStaticContent));

      const certDecoded = decrypt(serverHello.payload);

      try {
        // Decodifica certificado usando protobuf do @wppconnect/wa-proto
        const { intermediate: certIntermediate } = waproto.CertChain.decode(certDecoded);
        const { issuerSerial } = waproto.CertChain.NoiseCertificate.Details.decode(certIntermediate!.details!);
        
        if (issuerSerial !== WA_CERT_DETAILS.SERIAL) {
          console.error('❌ [HANDSHAKE ERROR] Falha na verificação do certificado');
          throw new Boom('certification match failed', { statusCode: 400 });
        }

        const keyEnc = encrypt(noiseKey.public);
        await mixIntoKey(Curve.sharedKey(noiseKey.private, serverHello.ephemeral));

        return keyEnc;
      } catch (error) {
         console.error('❌ [HANDSHAKE ERROR] Erro durante processamento:', {
           error: (error as Error).message,
           stack: (error as Error).stack,
           certDecodedHex: Buffer.from(certDecoded).toString('hex')
         });
         throw error;
       }
    },

    encodeFrame: (data: Buffer | Uint8Array) => {
      // NoiseHandler agora faz APENAS criptografia
      // O framing (header WA + length prefix) é responsabilidade do WebSocketClient
      if (isFinished) {
        data = encrypt(data);
      }
      return Buffer.from(data);
    },

    decodeFrame: async (newData: Buffer | Uint8Array, onFrame: (buff: Uint8Array | BinaryNode) => void) => {
      // the binary protocol uses its own framing mechanism
      // on top of the WS frames
      // so we get this data and separate out the frames
      const getBytesSize = () => {
        if (inBytes.length >= 3) {
          return (inBytes.readUInt8() << 16) | inBytes.readUInt16BE(1);
        }
        return undefined;
      };

      inBytes = Buffer.concat([inBytes, newData]);

      let size = getBytesSize();
      while (size && inBytes.length >= size + 3) {
        let frame: Uint8Array | BinaryNode = inBytes.slice(3, size + 3);
        inBytes = inBytes.slice(size + 3);

        if (isFinished) {
          const result = decrypt(frame);
          frame = await decodeBinaryNode(result) as any;
        }
        
        try {
          onFrame(frame);
        } catch (callbackError) {
          console.error(`❌ [NOISE_HANDLER] Erro no callback:`, callbackError);
        }
        
        size = getBytesSize();
      }
    },

    // Getters para compatibilidade
    getState: () => ({
      hash,
      salt,
      encKey,
      decKey,
      readCounter,
      writeCounter,
      isFinished
    }),

    isFinished: () => isFinished,
    
    getKeys: () => ({ 
      sendingKey: encKey, 
      receivingKey: decKey 
    })
  };
}

export default makeNoiseHandler;