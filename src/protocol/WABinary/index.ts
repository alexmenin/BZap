/**
 * WABinary - Sistema de codificação/decodificação do protocolo WhatsApp
 * Baseado na implementação do Baileys
 */

export { TAGS, SINGLE_BYTE_TOKENS, DOUBLE_BYTE_TOKENS } from '../../constants/Constants';
export { WABinaryDecoder, BinaryNode } from './decode';
export { WABinaryEncoder } from './encode';

// Importações para funções de conveniência
import { WABinaryDecoder } from './decode';
import { WABinaryEncoder } from './encode';

// Funções de conveniência
export const decode = WABinaryDecoder.decode;
export const encode = WABinaryEncoder.encode;