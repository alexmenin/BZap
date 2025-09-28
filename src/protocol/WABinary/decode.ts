import { promisify } from 'util';
import { inflate } from 'zlib';
import { TAGS, SINGLE_BYTE_TOKENS, DOUBLE_BYTE_TOKENS } from '../../constants/Constants';

const inflatePromise = promisify(inflate);

export interface BinaryNode {
    tag: string;
    attrs: { [key: string]: string };
    content?: BinaryNode[] | Uint8Array | string;
}

// Função para codificar JID (adaptada do jid-utils.js)
const jidEncode = (user: string, server: string, device?: number): string => {
    if (device) {
        return `${user}:${device}@${server}`;
    }
    return `${user}@${server}`;
};

export const decompressingIfRequired = async (buffer: Buffer): Promise<Buffer> => {
    if (2 & buffer.readUInt8()) {
        buffer = await inflatePromise(buffer.slice(1));
    } else {
        // nodes with no compression have a 0x00 prefix, we remove that
        buffer = buffer.slice(1);
    }
    return buffer;
};

export const decodeDecompressedBinaryNode = (
    buffer: Uint8Array,
    opts: { DOUBLE_BYTE_TOKENS: readonly (readonly string[])[], SINGLE_BYTE_TOKENS: readonly string[], TAGS: any },
    indexRef: { index: number } = { index: 0 }
): BinaryNode => {
    const { DOUBLE_BYTE_TOKENS, SINGLE_BYTE_TOKENS, TAGS } = opts;
    
    const checkEOS = (length: number) => {
        if (indexRef.index + length > buffer.length) {
            throw new Error('end of stream');
        }
    };

    const next = () => {
        const value = buffer[indexRef.index];
        indexRef.index += 1;
        return value;
    };

    const readByte = () => {
        checkEOS(1);
        return next();
    };

    const readBytes = (n: number) => {
        checkEOS(n);
        const value = buffer.slice(indexRef.index, indexRef.index + n);
        indexRef.index += n;
        return value;
    };

    const readStringFromChars = (length: number) => {
        const bytes = readBytes(length);
        return new TextDecoder('utf-8').decode(bytes);
    };

    const readInt = (n: number, littleEndian = false) => {
        checkEOS(n);
        let val = 0;
        for (let i = 0; i < n; i++) {
            const shift = littleEndian ? i : n - 1 - i;
            val |= next() << (shift * 8);
        }
        return val;
    };

    const readInt20 = () => {
        checkEOS(3);
        return ((next() & 15) << 16) + (next() << 8) + next();
    };

    const unpackHex = (value: number) => {
        if (value >= 0 && value < 16) {
            return value < 10 ? '0'.charCodeAt(0) + value : 'A'.charCodeAt(0) + value - 10;
        }
        throw new Error('invalid hex: ' + value);
    };

    const unpackNibble = (value: number) => {
        if (value >= 0 && value <= 9) {
            return '0'.charCodeAt(0) + value;
        }
        switch (value) {
            case 10:
                return '-'.charCodeAt(0);
            case 11:
                return '.'.charCodeAt(0);
            case 15:
                return '\0'.charCodeAt(0);
            default:
                throw new Error('invalid nibble: ' + value);
        }
    };

    const unpackByte = (tag: number, value: number) => {
        if (tag === TAGS.NIBBLE_8) {
            return unpackNibble(value);
        } else if (tag === TAGS.HEX_8) {
            return unpackHex(value);
        } else {
            throw new Error('unknown tag: ' + tag);
        }
    };

    const readPacked8 = (tag: number) => {
        const startByte = readByte();
        let value = '';
        for (let i = 0; i < (startByte & 127); i++) {
            const curByte = readByte();
            value += String.fromCharCode(unpackByte(tag, (curByte & 0xf0) >> 4));
            value += String.fromCharCode(unpackByte(tag, curByte & 0x0f));
        }
        if (startByte >> 7 !== 0) {
            value = value.slice(0, -1);
        }
        return value;
    };

    const isListTag = (tag: number) => {
        return tag === TAGS.LIST_EMPTY || tag === TAGS.LIST_8 || tag === TAGS.LIST_16;
    };

    const readListSize = (tag: number) => {
        switch (tag) {
            case TAGS.LIST_EMPTY:
                return 0;
            case TAGS.LIST_8:
                return readByte();
            case TAGS.LIST_16:
                return readInt(2);
            default:
                throw new Error('invalid tag for list size: ' + tag);
        }
    };

    const readJidPair = () => {
        const i = readString(readByte());
        const j = readString(readByte());
        if (j) {
            return (i || '') + '@' + j;
        }
        throw new Error('invalid jid pair: ' + i + ', ' + j);
    };

    const readAdJid = () => {
        const rawDomainType = readByte();
        const domainType = Number(rawDomainType);
        const device = readByte();
        const user = readString(readByte());
        return jidEncode(user, domainType === 0 || domainType === 128 ? 's.whatsapp.net' : 'lid', device);
    };

    const readString = (tag: number): string => {
        if (tag >= 1 && tag < SINGLE_BYTE_TOKENS.length) {
            return SINGLE_BYTE_TOKENS[tag] || '';
        }
        switch (tag) {
            case TAGS.DICTIONARY_0:
            case TAGS.DICTIONARY_1:
            case TAGS.DICTIONARY_2:
            case TAGS.DICTIONARY_3:
                return getTokenDouble(tag - TAGS.DICTIONARY_0, readByte());
            case TAGS.LIST_EMPTY:
                return '';
            case TAGS.BINARY_8:
                return readStringFromChars(readByte());
            case TAGS.BINARY_20:
                return readStringFromChars(readInt20());
            case TAGS.BINARY_32:
                return readStringFromChars(readInt(4));
            case TAGS.JID_PAIR:
                return readJidPair();
            case TAGS.AD_JID:
                return readAdJid();
            case TAGS.HEX_8:
            case TAGS.NIBBLE_8:
                return readPacked8(tag);
            default:
                throw new Error('invalid string with tag: ' + tag);
        }
    };

    const readList = (tag: number): BinaryNode[] => {
        const items: BinaryNode[] = [];
        const size = readListSize(tag);
        for (let i = 0; i < size; i++) {
            items.push(decodeDecompressedBinaryNode(buffer, opts, indexRef));
        }
        return items;
    };

    const readDoubleByteToken = () => {
        const n1 = readByte();
        const n2 = readByte();
        const index = (n1 - 236) * 256 + n2;
        // DOUBLE_BYTE_TOKENS agora é bidimensional
        const token = DOUBLE_BYTE_TOKENS[n1 - 236]?.[n2];
        return token || `unknown_double_byte_${index}`;
    };

    const getTokenDouble = (index1: number, index2: number): string => {
        const dict = DOUBLE_BYTE_TOKENS[index1];
        if (!dict) {
            throw new Error(`Invalid double token dict (${index1})`);
        }
        const value = dict[index2];
        if (typeof value === 'undefined') {
            throw new Error(`Invalid double token (${index2})`);
        }
        return value;
    };

    const listSize = readListSize(readByte());
    const header = readString(readByte());
    
    if (!listSize || !header.length) {
        throw new Error('invalid node');
    }

    const attrs: { [key: string]: string } = {};
    let data: BinaryNode[] | Uint8Array | string | undefined;

    if (listSize === 0 || !header) {
        throw new Error('invalid node');
    }

    // read the attributes in
    const attributesLength = (listSize - 1) >> 1;
    for (let i = 0; i < attributesLength; i++) {
        const key = readString(readByte());
        const value = readString(readByte());
        attrs[key] = value;
    }

    if (listSize % 2 === 0) {
        const tag = readByte();
        if (isListTag(tag)) {
            data = readList(tag);
        } else {
            let decoded: Uint8Array | string;
            switch (tag) {
                case TAGS.BINARY_8:
                    decoded = readBytes(readByte());
                    break;
                case TAGS.BINARY_20:
                    decoded = readBytes(readInt20());
                    break;
                case TAGS.BINARY_32:
                    decoded = readBytes(readInt(4));
                    break;
                default:
                    decoded = readString(tag);
                    break;
            }
            data = decoded;
        }
    }

    return {
        tag: header,
        attrs,
        content: data
    };
};

export const decodeBinaryNode = async (buff: Buffer): Promise<BinaryNode> => {
    const decompBuff = await decompressingIfRequired(buff);
    return decodeDecompressedBinaryNode(decompBuff, { DOUBLE_BYTE_TOKENS, SINGLE_BYTE_TOKENS, TAGS });
};

// Classe WABinaryDecoder para compatibilidade
export class WABinaryDecoder {
    static decode = decodeBinaryNode;
}

/**
 * Converte um BinaryNode para string XML formatada
 * Baseado na implementação do Baileys
 */
const tabs = (n: number) => '\t'.repeat(n);

export function binaryNodeToString(node: BinaryNode | BinaryNode['content'], i = 0): string {
    if (!node) {
        return node!;
    }

    if (typeof node === 'string') {
        return tabs(i) + node;
    }

    if (node instanceof Uint8Array || Buffer.isBuffer(node)) {
        return tabs(i) + Buffer.from(node).toString('hex');
    }

    if (Array.isArray(node)) {
        return node.map(x => tabs(i + 1) + binaryNodeToString(x, i + 1)).join('\n');
    }

    const children = binaryNodeToString(node.content, i + 1);

    const tag = `<${node.tag} ${Object.entries(node.attrs || {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}='${v}'`)
        .join(' ')}`;

    const content: string = children ? `>\n${children}\n${tabs(i)}</${node.tag}>` : '/>';

    return tag + content;
}