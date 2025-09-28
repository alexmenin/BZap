import { Boom } from '@hapi/boom'
import makeWASocket, { 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    useMultiFileAuthState,
    BinaryNode,
    binaryNodeToString,
    decodeBinaryNode
} from './Baileys-master/src'
import P from 'pino'
import fs from 'fs'
import path from 'path'

// Configurar logger com nível trace para capturar tudo
const logger = P({
    level: "trace",
    transport: {
        targets: [
            {
                target: "pino-pretty",
                options: { 
                    colorize: true,
                    translateTime: 'SYS:standard',
                    ignore: 'pid,hostname'
                },
                level: "trace",
            },
            {
                target: "pino/file",
                options: { destination: './handshake-debug.log' },
                level: "trace",
            },
        ],
    },
})

// Criar diretório para logs XML se não existir
const xmlLogsDir = './xml-logs'
if (!fs.existsSync(xmlLogsDir)) {
    fs.mkdirSync(xmlLogsDir)
}

let messageCounter = 0

// Função para salvar XML em arquivo
const saveXmlToFile = (xml: string, direction: 'sent' | 'received', timestamp: string) => {
    const filename = `${String(messageCounter).padStart(4, '0')}_${direction}_${timestamp}.xml`
    const filepath = path.join(xmlLogsDir, filename)
    fs.writeFileSync(filepath, xml, 'utf8')
    messageCounter++
}

// Função para interceptar e logar dados do WebSocket
const interceptWebSocketData = (sock: any) => {
    const originalSendNode = sock.sendNode
    const originalWs = sock.ws

    // Interceptar dados enviados
    if (originalSendNode) {
        sock.sendNode = function(frame: BinaryNode) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
            const xml = binaryNodeToString(frame)
            
            console.log('\n🔴 ENVIANDO XML:')
            console.log('═'.repeat(80))
            console.log(xml)
            console.log('═'.repeat(80))
            
            saveXmlToFile(xml, 'sent', timestamp)
            logger.info({ direction: 'SENT', xml }, 'XML Message Sent')
            
            return originalSendNode.call(this, frame)
        }
    }

    // Interceptar dados recebidos
    if (originalWs && originalWs.on) {
        const originalOn = originalWs.on.bind(originalWs)
        
        originalWs.on = function(event: string, listener: any) {
            if (event === 'message') {
                const wrappedListener = (data: Buffer) => {
                    try {
                        // Tentar decodificar os dados recebidos
                        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
                        
                        // Se os dados estão criptografados pelo noise protocol, 
                        // precisamos decodificar primeiro
                        if (sock.noise && sock.noise.decodeFrame) {
                            try {
                                const decoded = sock.noise.decodeFrame(data)
                                const binaryNode = decodeBinaryNode(decoded)
                                const xml = binaryNodeToString(binaryNode)
                                
                                console.log('\n🔵 RECEBIDO XML:')
                                console.log('═'.repeat(80))
                                console.log(xml)
                                console.log('═'.repeat(80))
                                
                                saveXmlToFile(xml, 'received', timestamp)
                                logger.info({ direction: 'RECEIVED', xml }, 'XML Message Received')
                            } catch (decodeError) {
                                console.log('\n🟡 DADOS BRUTOS RECEBIDOS (não decodificável como XML):')
                                console.log('═'.repeat(80))
                                console.log('Tamanho:', data.length, 'bytes')
                                console.log('Hex:', data.toString('hex').substring(0, 200) + '...')
                                console.log('═'.repeat(80))
                                
                                logger.info({ 
                                    direction: 'RECEIVED_RAW', 
                                    size: data.length,
                                    hex: data.toString('hex').substring(0, 200)
                                }, 'Raw data received (not XML)')
                            }
                        }
                    } catch (error) {
                        logger.error({ error: error.message }, 'Error intercepting received data')
                    }
                    
                    // Chamar o listener original
                    return listener(data)
                }
                
                return originalOn(event, wrappedListener)
            }
            
            return originalOn(event, listener)
        }
    }
}

const startDebugSession = async () => {
    console.log('🚀 Iniciando sessão de debug do handshake Baileys...')
    console.log('📁 XMLs serão salvos em:', path.resolve(xmlLogsDir))
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_debug')
        const { version, isLatest } = await fetchLatestBaileysVersion()
        
        console.log(`📱 Usando WA v${version.join('.')}, isLatest: ${isLatest}`)
        
        const sock = makeWASocket({
            version,
            logger,
            auth: state,
            printQRInTerminal: false, // Vamos capturar o QR de outra forma
            browser: ['Debug Baileys', 'Chrome', '1.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false
        })

        // Interceptar dados do WebSocket
        interceptWebSocketData(sock)

        sock.ev.on('creds.update', saveCreds)

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update
            
            console.log('\n📡 CONNECTION UPDATE:', {
                connection,
                hasQR: !!qr,
                lastDisconnect: lastDisconnect?.error?.message
            })
            
            if (qr) {
                console.log('\n📱 QR CODE RECEBIDO!')
                console.log('QR String:', qr)
                
                // Salvar QR em arquivo
                fs.writeFileSync('./qr-code.txt', qr)
                console.log('💾 QR salvo em: qr-code.txt')
                
                // Aqui você pode usar uma biblioteca para gerar o QR visual se quiser
                console.log('\n✅ HANDSHAKE COMPLETO ATÉ QR CODE!')
                console.log('🔍 Verifique os arquivos XML em:', path.resolve(xmlLogsDir))
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
                console.log('🔌 Conexão fechada. Reconectar?', shouldReconnect)
                
                if (shouldReconnect) {
                    console.log('🔄 Tentando reconectar...')
                    setTimeout(startDebugSession, 3000)
                } else {
                    console.log('👋 Sessão encerrada (logged out)')
                    process.exit(0)
                }
            }
            
            if (connection === 'open') {
                console.log('✅ Conexão estabelecida com sucesso!')
            }
        })

        // Log de eventos importantes
        sock.ev.on('messages.upsert', ({ messages, type }) => {
            console.log(`📨 Mensagens recebidas: ${messages.length} (${type})`)
        })

    } catch (error) {
        console.error('❌ Erro durante debug:', error)
        logger.error({ error: error.message }, 'Debug session error')
    }
}

// Capturar sinais para limpeza
process.on('SIGINT', () => {
    console.log('\n🛑 Encerrando sessão de debug...')
    console.log('📊 Total de mensagens XML capturadas:', messageCounter)
    process.exit(0)
})

console.log('🔧 Baileys Handshake Debug Tool')
console.log('================================')
console.log('Este script captura todos os XMLs enviados e recebidos durante o handshake')
console.log('até a geração do QR code.')
console.log('')

startDebugSession()