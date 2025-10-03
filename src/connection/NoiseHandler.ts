import { Boom } from '@hapi/boom';
import { KeyPair } from '../crypto/KeyManager';
import { BinaryNode } from '../protocol/WABinary/decode';
import { aesDecryptGCM, aesEncryptGCM, Curve, hkdf, sha256 } from '../crypto/Curve25519';
import { Logger } from '../utils/Logger';
import { NOISE_CONFIG } from '../constants/Constants';
import { decodeBinaryNode } from '../protocol/WABinary/decode';
import { waproto } from '@wppconnect/wa-proto';
import { MessageDecryption } from '../crypto/MessageDecryption';
import { AuthenticationState } from '../auth/AuthStateManager';

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
  authState?: AuthenticationState;
  instanceId?: string; // ✅ Propaga instanceId para SignalRepository/SignalProtocolStore
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
  // Controla a verbosidade dos logs do NoiseHandler via variável de ambiente
  const VERBOSE_NOISE_LOG = process.env.VERBOSE_NOISE_LOG === 'true';
  const { keyPair, logger, routingInfo, authState, instanceId } = options;
  const { private: privateKey, public: publicKey } = keyPair;

  // Singleton SignalRepository por instância de conexão
  let signalRepository: any = null;

  // Função para obter ou criar SignalRepository (singleton)
  const getSignalRepository = async (authState: AuthenticationState) => {
    if (!signalRepository) {
      console.log('🏗️ [SIGNAL] Criando SignalRepository (singleton)...');
      const { SignalRepository } = await import('../crypto/SignalRepository');
      // ✅ Passe também o authState para permitir persistência imediata (Prisma)
      signalRepository = await SignalRepository.create(
        authState.creds,
        authState.keys,
        instanceId,
        authState
      );
      console.log('✅ [SIGNAL] SignalRepository singleton criado com sucesso');
      if (!instanceId) {
        console.warn('⚠️ [SIGNAL] NoiseHandler inicializado sem instanceId — operações Prisma ficarão desabilitadas no SignalProtocolStore');
      } else {
        console.log(`🔖 [SIGNAL] NoiseHandler associado à instância: ${instanceId}`);
      }
      
      // ✅ Atualiza companion_enc_static se disponível
      if (authState.creds.companionKey) {
        signalRepository.updateCompanionKey(authState.creds.companionKey);
        console.log('🔑 [SIGNAL] companion_enc_static atualizado no SignalRepository');
      }
    } else {
      console.log('♻️ [SIGNAL] Reutilizando SignalRepository existente');
      
      // ✅ Verifica se companion_enc_static foi atualizado
      if (authState.creds.companionKey && !signalRepository.getStorage().getCompanionKey()) {
        signalRepository.updateCompanionKey(authState.creds.companionKey);
        console.log('🔑 [SIGNAL] companion_enc_static atualizado no SignalRepository existente');
      }
    }
    return signalRepository;
  };

  // Função para processar descriptografia Signal Protocol usando SignalRepository (padrão Baileys)
  const processSignalDecryption = async (messageFrame: any, authState: AuthenticationState) => {
    console.log('🔍 [SIGNAL] Iniciando processamento de descriptografia Signal Protocol');
    console.log('📋 [SIGNAL] Frame da mensagem:', {
      tag: messageFrame.tag,
      attrs: messageFrame.attrs,
      contentLength: messageFrame.content?.length,
      contentTypes: messageFrame.content?.map((node: any) => node.tag)
    });

    try {
      // Procura por nós <enc> no conteúdo da mensagem
      const encNodes = messageFrame.content.filter((node: any) => node.tag === 'enc');
      
      console.log(`🔍 [SIGNAL] Encontrados ${encNodes.length} nós <enc> para processar`);
      
      if (encNodes.length === 0) {
        console.log('ℹ️ [SIGNAL] Nenhum nó <enc> encontrado - mensagem não criptografada ou já processada');
        return;
      }
      
      for (const encNode of encNodes) {
        console.log('🔐 [SIGNAL] Processando nó <enc>:', {
          type: encNode.attrs?.type,
          version: encNode.attrs?.v,
          from: messageFrame.attrs?.from,
          contentType: typeof encNode.content,
          contentLength: encNode.content?.length
        });
        
        try {
          // Obtém SignalRepository singleton
          const repository = await getSignalRepository(authState);
          
          // Extrai dados do nó <enc>
          const encType = encNode.attrs?.type; // 'pkmsg' ou 'msg'
          // Extrai o JID real do remetente. Em mensagens de grupo, o sender vem em 'participant'.
          const senderJid = encNode.attrs?.from
            || encNode.attrs?.participant
            || messageFrame.attrs?.participant
            || messageFrame.attrs?.from;
          
          console.log('📊 [SIGNAL] Dados extraídos:', {
            encType,
            senderJid,
            hasContent: !!encNode.content
          });
          
          if (!encType || !senderJid) {
            throw new Error(`Dados insuficientes: type=${encType}, from=${senderJid}`);
          }
          
          // Tenta diferentes formatos de decodificação do conteúdo
          let ciphertext: Buffer;
          try {
            if (typeof encNode.content === 'string') {
              // Tenta base64 primeiro
              ciphertext = Buffer.from(encNode.content, 'base64');
              console.log('📝 [SIGNAL] Conteúdo decodificado como base64');
            } else if (Buffer.isBuffer(encNode.content)) {
              ciphertext = encNode.content;
              console.log('📝 [SIGNAL] Conteúdo já é Buffer');
            } else if (encNode.content instanceof Uint8Array) {
              ciphertext = Buffer.from(encNode.content);
              console.log('📝 [SIGNAL] Conteúdo convertido de Uint8Array');
            } else {
              throw new Error(`Formato de conteúdo não suportado: ${typeof encNode.content}`);
            }
            
            console.log('📏 [SIGNAL] Tamanho do ciphertext:', ciphertext.length);
          } catch (contentError) {
            console.error('❌ [SIGNAL] Erro ao processar conteúdo:', contentError);
            throw contentError;
          }
          
          // Descriptografa usando repository.decryptMessage (igual ao Baileys)
          console.log(`🔓 [SIGNAL] Iniciando descriptografia ${encType} de ${senderJid}...`);
          const decryptedBuffer = await repository.decryptMessage({
            jid: senderJid,
            type: encType as 'pkmsg' | 'msg',
            ciphertext: ciphertext
          });
          
          console.log('✅ [SIGNAL] Descriptografia Signal Protocol concluída');
          console.log('📏 [SIGNAL] Tamanho do buffer descriptografado:', decryptedBuffer.length);
          
          // Remove padding PKCS7 (igual ao Baileys)
          console.log('🔧 [SIGNAL] Removendo padding PKCS7...');
          const { unpadRandomMax16 } = await import('../utils/SignalUtils');
          const unpaddedBuffer = unpadRandomMax16(decryptedBuffer);
          
          console.log('✅ [SIGNAL] Padding removido');
          console.log('📏 [SIGNAL] Tamanho após remoção do padding:', unpaddedBuffer.length);
          
          // Decodifica mensagem usando protobuf
          console.log('🔍 [SIGNAL] Decodificando mensagem protobuf...');
          const decodedMessage = waproto.Message.decode(unpaddedBuffer);
          
          console.log('✅ [SIGNAL] Mensagem descriptografada com sucesso!');
          // console.log('📄 [SIGNAL] Conteúdo da mensagem:', JSON.stringify(decodedMessage, null, 2));
          
          // Log adicional para tipos específicos de mensagem
          if (decodedMessage.conversation) {
            console.log('💬 [SIGNAL] Mensagem de texto:', decodedMessage.conversation);
          }
          if (decodedMessage.extendedTextMessage) {
            console.log('📝 [SIGNAL] Mensagem de texto estendida:', decodedMessage.extendedTextMessage.text);
          }
          
        } catch (decryptError) {
          console.error('❌ [SIGNAL] Falha na descriptografia:', {
            error: decryptError instanceof Error ? decryptError.message : String(decryptError),
            stack: decryptError instanceof Error ? decryptError.stack : undefined,
            type: encNode.attrs?.type,
            from: messageFrame.attrs?.from,
            contentType: typeof encNode.content,
            contentLength: encNode.content?.length
          });
        }
      }
    } catch (error) {
      console.error('❌ [SIGNAL] Erro geral ao processar descriptografia:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  };

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
          
          if (VERBOSE_NOISE_LOG) {
            (options.logger as any)?.debug?.('📨 [NOISE] Frame decodificado:', {
              tag: (frame as any)?.tag,
              attrs: (frame as any)?.attrs,
              hasContent: !!(frame as any)?.content,
              contentLength: (frame as any)?.content?.length
            });
          }
          
          // 🔍 Descriptografia Signal Protocol para mensagens com nó <enc>
          if ((frame as any)?.tag === 'message') {
            if (VERBOSE_NOISE_LOG) {
              (options.logger as any)?.debug?.('📩 [NOISE] Frame de mensagem detectado - verificando authState...');
            }
            // Processa descriptografia Signal Protocol se authState estiver disponível
            if (authState && typeof frame === 'object' && 'content' in frame && Array.isArray(frame.content)) {
              if (VERBOSE_NOISE_LOG) {
                (options.logger as any)?.debug?.('✅ [NOISE] AuthState disponível - iniciando processamento Signal Protocol');
              }
              await processSignalDecryption(frame as BinaryNode, authState);
            } else {
              if (VERBOSE_NOISE_LOG) {
                (options.logger as any)?.debug?.('⚠️ [NOISE] AuthState não disponível ou frame inválido:', {
                  hasAuthState: !!authState,
                  frameType: typeof frame,
                  hasContent: 'content' in (frame as any),
                  contentIsArray: Array.isArray((frame as any)?.content)
                });
              }
            }
          } else {
            if (VERBOSE_NOISE_LOG) {
              (options.logger as any)?.debug?.('📋 [NOISE] Frame não é mensagem:', (frame as any)?.tag);
            }
          }
        }
        
        try {
          onFrame(frame);
        } catch (callbackError) {
          (options.logger as any)?.error?.(`❌ [NOISE_HANDLER] Erro no callback:`, callbackError);
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