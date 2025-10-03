// app.js - Aplicação frontend para gerenciamento de instâncias WhatsApp

class WhatsAppManager {
    constructor() {
        this.apiBaseUrl = window.location.origin + '/api';
        this.instances = [];
        this.currentQrInstance = null;
        this.qrRefreshInterval = null;
        this.qrCountdownInterval = null;
        this.connectionMonitorInterval = null;
        this.eventSource = null;
        this.socket = null; // WebSocket connection
        
        this.init();
    }

    // Função para conectar ao WebSocket
    connectToWebSocket() {
        // Fecha conexão anterior se existir
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }

        console.log('🔌 Conectando ao WebSocket...');
        console.log('🔍 [DEBUG] URL atual:', window.location.origin);
        console.log('🔍 [DEBUG] Socket.IO disponível:', typeof io !== 'undefined');
        
        // Conecta ao servidor WebSocket usando Socket.IO
        try {
            this.socket = io();
            console.log('🔍 [DEBUG] Socket criado:', !!this.socket);
        } catch (error) {
            console.error('❌ Erro ao criar socket:', error);
            return;
        }

        // Event listeners do WebSocket
        this.socket.on('connect', () => {
            console.log('✅ Conectado ao WebSocket');
            console.log('🔍 [DEBUG] Socket ID:', this.socket.id);
        });

        this.socket.on('disconnect', (reason) => {
            console.log('❌ Desconectado do WebSocket:', reason);
        });

        this.socket.on('connect_error', (error) => {
            console.error('❌ Erro de conexão WebSocket:', error);
        });

        // Listener principal para mensagens WebSocket
        this.socket.on('message', (event) => {
            console.log('📨 Mensagem WebSocket recebida:', event);
            
            let data;
            try {
                // Se event já é um objeto, usa diretamente
                if (typeof event === 'object' && event !== null) {
                    data = event;
                } else if (typeof event === 'string') {
                    // Se é string, tenta fazer parse
                    data = JSON.parse(event);
                } else if (event.data) {
                    // Se tem propriedade data, tenta fazer parse dela
                    data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
                } else {
                    console.warn('⚠️ Formato de evento desconhecido:', event);
                    return;
                }
            } catch (err) {
                console.error('❌ Erro ao parsear evento WebSocket:', event, err);
                return;
            }

            console.log('🔍 Dados parseados do WebSocket:', data);

            // Processar QR code
            if (data.type === 'qr' && data.qr) {
                console.log('🎯 QR code detectado via message event:', data.qr.substring(0, 50) + '...');
                
                const container = document.getElementById('qrCodeContainer');
                if (container) {
                    container.innerHTML = ''; // limpar QR anterior
                    
                    try {
                        QrCreator.render({ 
                            text: data.qr, 
                            size: 256,
                            radius: 0,
                            ecLevel: 'L',
                            fill: '#000000',
                            background: '#FFFFFF'
                        }, container);
                        
                        console.log('✅ QR Code renderizado via message event');
                        
                        // Exibir modal
                        const modal = document.getElementById('qrModal');
                        if (modal && !modal.classList.contains('show')) {
                            modal.classList.add('show');
                            document.body.style.overflow = 'hidden';
                        }
                        
                        // Atualizar nome da instância se disponível
                        if (data.instanceName) {
                            const instanceNameEl = document.getElementById('qrInstanceName');
                            if (instanceNameEl) {
                                instanceNameEl.textContent = data.instanceName;
                            }
                        }
                        
                        this.updateQrModalStatus('📱 Escaneie o QR Code com seu WhatsApp', 'qr_code');
                        
                    } catch (error) {
                        console.error('❌ Erro ao renderizar QR code via message event:', error);
                        container.innerHTML = `
                            <div class="empty-state">
                                <i class="fas fa-exclamation-triangle"></i>
                                <p>Erro ao gerar QR Code</p>
                                <p class="text-muted">${error.message}</p>
                            </div>
                        `;
                    }
                }
            }

            // Processar status de conexão
            if (data.type === 'status') {
                console.log('📊 Status update via message event:', data.status);
                const statusEl = document.getElementById('connectionStatus');
                if (statusEl) {
                    statusEl.textContent = data.status;
                }
                
                if (data.instanceId) {
                    this.updateInstanceStatus(data.status, data.instanceId);
                }
            }

            // Processar connection.update
            if (data.type === 'connection.update' || (data.connection && data.update)) {
                console.log('🔄 Connection update via message event:', data);
                this.handleConnectionUpdate(data);
            }
        });

        this.socket.on('instance_status_update', (data) => {
            console.log('📊 Status da instância atualizado via WebSocket:', data);
            this.handleInstanceStatusUpdate(data);
            
            // ✅ CORREÇÃO: Processar connection.update dentro do instance_status_update
            if (data.data && data.data.connection) {
                console.log('🔄 Connection update detectado:', data.data);
                this.handleConnectionUpdate(data);
            }
        });

        this.socket.on('qr_code_generated', (data) => {
            console.log('📱 Novo QR code recebido via WebSocket:', data);
            this.handleQRCodeGenerated(data);
        });

        this.socket.on('instance_connected', (data) => {
            console.log('✅ Instância conectada via WebSocket:', data);
            this.handleInstanceConnected(data);
        });

        this.socket.on('instance_disconnected', (data) => {
            console.log('❌ Instância desconectada via WebSocket:', data);
            this.handleInstanceDisconnected(data);
        });

        this.socket.on('qr_code_response', (data) => {
            console.log('📱 QR code response via WebSocket:', data);
            if (data.qrCode) {
                this.updateQRCodeDisplay(data.qrCode);
            }
        });

        this.socket.on('instance_status_response', (data) => {
            console.log('📊 Instance status response via WebSocket:', data);
            if (data.status) {
                this.updateInstanceStatus(data.status.status, data.instanceId);
            }
        });

        this.socket.on('connection_update', (data) => {
            console.log('🔄 Connection update recebido via WebSocket:', data);
            this.handleConnectionUpdate(data);
        });

        this.socket.on('error', (error) => {
            console.error('❌ Erro no WebSocket:', error);
        });
    }

    // Handler para atualização de status da instância
    handleInstanceStatusUpdate(data) {
        console.log('🔍 [DEBUG] handleInstanceStatusUpdate recebido:', data);
        
        if (this.currentQrInstance && this.currentQrInstance.id === data.instanceId) {
            const status = data.status;
            console.log('🔍 [DEBUG] Status da instância atual:', status);
            
            // Processar connection.update se presente
            if (data.data && data.data.connection) {
                console.log('🔄 Connection update detectado no status update:', data.data);
                this.handleConnectionUpdate(data);
            }
            
            // Verifica se a instância já está conectada para evitar processar QR codes desnecessários
            const currentInstanceStatus = this.getCurrentInstanceStatus(data.instanceId);
            
            // Se conectou com sucesso
            if (status === 'connected') {
                this.handleSuccessfulConnection(data.instanceId);
                return;
            }
            
            // Ignora QR codes se já está conectado
            if (status === 'qr_code' && currentInstanceStatus === 'connected') {
                console.log('⚠️ Ignorando QR code - instância já conectada');
                return;
            }
            
            // Se QR code foi escaneado
            if (status === 'qr_scanned') {
                console.log('🎉 QR Code escaneado detectado via WebSocket!');
                this.updateQrModalStatus('🎉 QR Code escaneado! Conectando...', 'connecting');
            }
            
            // Se está conectando
            if (status === 'connecting') {
                console.log('🔄 Status connecting detectado via WebSocket');
                this.updateQrModalStatus('🔄 Finalizando autenticação...', 'connecting');
            }
            
            // Se desconectou inesperadamente
            if (status === 'disconnected') {
                this.updateQrModalStatus('Desconectado', 'disconnected');
            }

            // Se está gerando QR code
            if (status === 'qr_code') {
                this.updateQrModalStatus('📱 Gerando QR Code...', 'qr_code');
            }
        }
        
        // Atualiza status na lista de instâncias
        this.updateInstanceStatus(data.status, data.instanceId);
    }

    // Handler para QR code gerado
    handleQRCodeGenerated(data) {
        if (this.currentQrInstance && this.currentQrInstance.id === data.instanceId) {
            console.log('📱 Atualizando QR code via WebSocket');
            // Usar 'qr' ou 'qrCode' dependendo do que está disponível
            const qrCode = data.qr || data.qrCode;
            if (qrCode) {
                this.updateQRCodeDisplay(qrCode);
            } else {
                console.warn('⚠️ QR code não encontrado nos dados:', data);
            }
        }
    }

    // Handler para instância conectada
    handleInstanceConnected(data) {
        if (this.currentQrInstance && this.currentQrInstance.id === data.instanceId) {
            this.handleSuccessfulConnection(data.instanceId);
        }
    }

    // Handler para instância desconectada
    handleInstanceDisconnected(data) {
        if (this.currentQrInstance && this.currentQrInstance.id === data.instanceId) {
            this.updateQrModalStatus('❌ Desconectado', 'disconnected');
        }
        this.updateInstanceStatus('disconnected', data.instanceId);
    }

    // ✅ NOVO: Handler para connection.update
    handleConnectionUpdate(data) {
        console.log('🔄 Processando connection.update:', data);
        console.log('🔍 [DEBUG] handleConnectionUpdate chamado:', data);
        
        const { instanceId, data: connectionData } = data;
        
        // Verifica se há QR code no connection.update
        if (connectionData && connectionData.qr) {
            console.log('📱 QR code encontrado no connection.update:', connectionData.qr.substring(0, 50) + '...');
            
            // Renderiza o QR code se estivermos na instância correta
            if (this.currentQrInstance && this.currentQrInstance.id === instanceId) {
                console.log('🔍 [DEBUG] Connection update para instância atual');
                this.updateQRCodeDisplay(connectionData.qr);
            }
        }
        
        // Atualiza status da conexão
        if (connectionData && connectionData.connection) {
            const status = connectionData.connection;
            console.log(`📊 Atualizando status da conexão para: ${status}`);
            console.log('🔍 [DEBUG] Status de conexão:', status);
            
            if (status === 'connected' || status === 'open') {
                console.log('✅ Conexão estabelecida!');
                this.handleSuccessfulConnection(instanceId);
            } else if (status === 'connecting') {
                this.updateInstanceStatus('connecting', instanceId);
            } else if (status === 'close') {
                console.log('❌ Conexão fechada');
                this.updateInstanceStatus('disconnected', instanceId);
            }
        }
    }

    // Função para se inscrever em eventos de uma instância
    subscribeToInstance(instanceId) {
        if (this.socket && this.socket.connected) {
            console.log(`📡 Inscrevendo-se em eventos da instância: ${instanceId}`);
            this.socket.emit('subscribe_instance', { instanceId });
        }
    }

    // Função para cancelar inscrição em eventos de uma instância
    unsubscribeFromInstance(instanceId) {
        if (this.socket && this.socket.connected) {
            console.log(`📡 Cancelando inscrição em eventos da instância: ${instanceId}`);
            this.socket.emit('unsubscribe_instance', { instanceId });
        }
    }

    // Função para solicitar status da instância via WebSocket
    requestInstanceStatus(instanceId) {
        if (this.socket && this.socket.connected) {
            console.log(`📊 Solicitando status da instância via WebSocket: ${instanceId}`);
            this.socket.emit('get_instance_status', { instanceId });
        }
    }

    // Função para solicitar QR code via WebSocket
    requestQRCode(instanceId) {
        if (this.socket && this.socket.connected) {
            console.log(`📱 Solicitando QR code via WebSocket: ${instanceId}`);
            this.socket.emit('get_qr_code', { instanceId });
        }
    }

    // Função para conectar ao SSE (mantida para compatibilidade, mas não será mais usada)
    connectToSSE(instanceId) {
        // Esta função foi substituída pela conexão WebSocket
        console.log('⚠️ SSE foi substituído por WebSocket');
        return;
    }

    // Função para desconectar do WebSocket
    disconnectFromWebSocket() {
        if (this.socket) {
            console.log('🔌 Desconectando do WebSocket');
            this.socket.disconnect();
            this.socket = null;
        }
    }

    // Função para atualizar o display do QR code
    updateQRCodeDisplay(qrCodeData) {
        try {
            let qrCodeText;
            
            // Verifica se qrCodeData é um objeto com propriedade 'qr' ou já é uma string
            if (typeof qrCodeData === 'object' && qrCodeData !== null) {
                if (qrCodeData.qr) {
                    qrCodeText = qrCodeData.qr;
                } else {
                    console.warn('⚠️ QR code object não possui propriedade "qr":', qrCodeData);
                    return;
                }
            } else if (typeof qrCodeData === 'string') {
                qrCodeText = qrCodeData;
            } else {
                console.error('❌ Formato de QR code inválido:', qrCodeData);
                return;
            }

            console.log('🎯 Atualizando QR code no display:', {
                content: qrCodeText.substring(0, 50) + '...',
                type: typeof qrCodeText,
                length: qrCodeText.length
            });

            // Atualiza a variável global
            this.currentQrData = qrCodeText;

            const qrContainer = document.getElementById('qrCodeContainer');
            if (!qrContainer) {
                console.error('❌ Container qrCodeContainer não encontrado');
                return;
            }

            // Limpar container anterior
            qrContainer.innerHTML = '';
            
            // Garantir que o modal seja exibido
            const modal = document.getElementById('qrModal');
            if (modal && !modal.classList.contains('show')) {
                modal.classList.add('show');
                document.body.style.overflow = 'hidden';
                console.log('✅ Modal QR exibido');
            }
            
            // Gerar QR Code visual usando QrCreator
            try {
                QrCreator.render({
                    text: qrCodeText,
                    size: 256,
                    radius: 0,
                    ecLevel: 'L',
                    fill: '#000000',
                    background: '#FFFFFF'
                }, qrContainer);
                
                console.log('✅ QR Code renderizado com sucesso via QrCreator');
                
                // Mostrar informações do QR code
                const infoContainer = document.createElement('div');
                infoContainer.className = 'qr-info';
                infoContainer.style.textAlign = 'center';
                infoContainer.style.marginTop = '15px';
                
                const wsText = document.createElement('p');
                wsText.className = 'text-success';
                wsText.innerHTML = '<i class="fas fa-wifi"></i> QR Code atualizado via WebSocket';
                infoContainer.appendChild(wsText);
                
                qrContainer.appendChild(infoContainer);
                
                // Atualizar status do modal
                this.updateQrModalStatus('Escaneie o QR Code com seu WhatsApp', 'qr_code');
                
                console.log('✅ QR code atualizado com sucesso via WebSocket');
                
            } catch (error) {
                console.error('❌ Erro ao renderizar QR code com QrCreator:', error);
                
                // Fallback: mostrar mensagem de erro
                qrContainer.innerHTML = `
                    <div class="empty-state">
                        <i class="fas fa-exclamation-triangle"></i>
                        <p>Erro ao gerar QR Code</p>
                        <p class="text-muted">${error.message}</p>
                    </div>
                `;
            }
            
        } catch (error) {
            console.error('❌ Erro geral no updateQRCodeDisplay:', error);
            const qrContainer = document.getElementById('qrCodeContainer');
            if (qrContainer) {
                qrContainer.innerHTML = `
                    <div class="empty-state">
                        <i class="fas fa-exclamation-triangle"></i>
                        <p>Erro ao processar QR Code</p>
                    </div>
                `;
            }
        }
    }

    // Função para desconectar do SSE (mantida para compatibilidade)
    disconnectFromSSE() {
        if (this.eventSource) {
            console.log('🔌 Desconectando do SSE');
            this.eventSource.close();
            this.eventSource = null;
        }
    }

    init() {
        this.bindEvents();
        this.loadInstances();
        this.setupModalEvents();
        this.setupToastEvents();
        // Conecta ao WebSocket na inicialização
        this.connectToWebSocket();
    }

    bindEvents() {
        // Formulário de criação de instância
        const createForm = document.getElementById('createInstanceForm');
        createForm.addEventListener('submit', (e) => this.handleCreateInstance(e));

        // Botão de atualizar instâncias
        const refreshBtn = document.getElementById('refreshInstances');
        refreshBtn.addEventListener('click', () => this.loadInstances());
    }

    setupModalEvents() {
        const modal = document.getElementById('qrModal');
        const closeBtn = document.getElementById('closeQrModal');
        const regenerateBtn = document.getElementById('regenerateQr');
        const downloadBtn = document.getElementById('downloadQr');

        // Fechar modal
        closeBtn.addEventListener('click', () => this.closeQrModal());
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.closeQrModal();
        });

        // Regenerar QR
        regenerateBtn.addEventListener('click', () => this.regenerateQrCode());

        // Download QR
        downloadBtn.addEventListener('click', () => this.downloadQrCode());

        // Fechar modal com ESC
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.classList.contains('show')) {
                this.closeQrModal();
            }
        });
    }

    setupToastEvents() {
        const toastClose = document.getElementById('toastClose');
        toastClose.addEventListener('click', () => this.hideToast());
    }

    async handleCreateInstance(e) {
        e.preventDefault();
        
        const formData = new FormData(e.target);
        const instanceData = {
            name: formData.get('name')
            // Removido webhookUrl - foco apenas em handshake e QR
        };

        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalText = submitBtn.innerHTML;
        
        try {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Criando...';

            const response = await fetch(`${this.apiBaseUrl}/instance`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(instanceData)
            });

            const result = await response.json();

            if (response.ok) {
                this.showToast('Instância criada com sucesso!', 'success');
                e.target.reset();
                await this.loadInstances();
            } else {
                throw new Error(result.message || 'Erro ao criar instância');
            }
        } catch (error) {
            console.error('Erro ao criar instância:', error);
            this.showToast(`Erro: ${error.message}`, 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalText;
        }
    }

    async loadInstances() {
        const loadingEl = document.getElementById('loadingInstances');
        const listEl = document.getElementById('instancesList');
        const noInstancesEl = document.getElementById('noInstances');

        try {
            loadingEl.style.display = 'block';
            listEl.style.display = 'none';
            noInstancesEl.style.display = 'none';

            const response = await fetch(`${this.apiBaseUrl}/instance`);
            const result = await response.json();

            if (response.ok) {
                this.instances = result.data || [];
                
                // ✅ CORREÇÃO: Força atualização do status real de cada instância via WebSocket
                console.log('🔄 Solicitando status atualizado para todas as instâncias...');
                this.instances.forEach(instance => {
                    if (this.socket && this.socket.connected) {
                        console.log(`📊 Solicitando status para instância: ${instance.id}`);
                        this.requestInstanceStatus(instance.id);
                    }
                });
                
                this.renderInstances();
            } else {
                throw new Error(result.message || 'Erro ao carregar instâncias');
            }
        } catch (error) {
            console.error('Erro ao carregar instâncias:', error);
            this.showToast(`Erro ao carregar instâncias: ${error.message}`, 'error');
            this.instances = [];
            this.renderInstances();
        } finally {
            loadingEl.style.display = 'none';
        }
    }

    renderInstances() {
        const listEl = document.getElementById('instancesList');
        const noInstancesEl = document.getElementById('noInstances');

        if (this.instances.length === 0) {
            listEl.style.display = 'none';
            noInstancesEl.style.display = 'block';
            return;
        }

        listEl.style.display = 'grid';
        noInstancesEl.style.display = 'none';

        listEl.innerHTML = this.instances.map(instance => this.renderInstanceCard(instance)).join('');
        
        // Bind eventos dos botões
        this.bindInstanceEvents();
    }

    renderInstanceCard(instance) {
        const statusClass = this.getStatusClass(instance.status);
        const statusText = this.getStatusText(instance.status);
        const createdAt = new Date(instance.createdAt).toLocaleString('pt-BR');
        
        // Define o botão principal baseado no status
        let primaryButton = '';
        if (instance.status === 'connected') {
            primaryButton = `
                <button class="btn btn-success" disabled>
                    <i class="fas fa-check-circle"></i> Conectado
                </button>
            `;
        } else {
            primaryButton = `
                <button class="btn btn-primary connect-btn" data-instance-id="${instance.id}" data-instance-name="${this.escapeHtml(instance.name)}">
                    <i class="fas fa-plug"></i> Conectar
                </button>
            `;
        }
    
        return `
            <div class="instance-card fade-in" data-instance-id="${instance.id}">
                <div class="instance-header">
                    <div class="instance-name">${this.escapeHtml(instance.name)}</div>
                    <div class="instance-status ${statusClass}">${statusText}</div>
                </div>
                <div class="instance-info">
                    <p><strong>ID:</strong> ${instance.id}</p>
                    <p><strong>Criado em:</strong> ${createdAt}</p>
                </div>
                <div class="instance-actions">
                    ${primaryButton}
                    <button class="btn btn-danger delete-btn" data-instance-id="${instance.id}" data-instance-name="${this.escapeHtml(instance.name)}">
                        <i class="fas fa-trash"></i> Excluir
                    </button>
                </div>
            </div>
        `;
    }

    bindInstanceEvents() {
        // Botões de Conectar
        document.querySelectorAll('.connect-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const instanceId = e.target.closest('.connect-btn').dataset.instanceId;
                const instanceName = e.target.closest('.connect-btn').dataset.instanceName;
                this.connectInstance(instanceId, instanceName);
            });
        });

        // Botões de excluir
        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const instanceId = e.target.closest('.delete-btn').dataset.instanceId;
                const instanceName = e.target.closest('.delete-btn').dataset.instanceName;
                this.deleteInstance(instanceId, instanceName);
            });
        });
    }

    async connectInstance(instanceId, instanceName) {
        const modal = document.getElementById('qrModal');
        const instanceNameEl = document.getElementById('qrInstanceName');
        const qrContainer = document.getElementById('qrCodeContainer');

        this.currentQrInstance = { id: instanceId, name: instanceName };
        instanceNameEl.textContent = instanceName;
        
        // Limpar container
        qrContainer.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i><br>Conectando via WebSocket...</div>';
        
        // Mostrar modal
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';

        try {
            // Inscrever-se em eventos da instância via WebSocket
            this.subscribeToInstance(instanceId);
            
            // Solicitar QR code inicial via WebSocket
            this.requestQRCode(instanceId);
            
            // Solicitar status inicial via WebSocket
            this.requestInstanceStatus(instanceId);
            
            // Gerar QR code via API (fallback)
            await this.generateQrCode(instanceId);
        } catch (error) {
            qrContainer.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Erro ao conectar</p><p class="text-muted">${error.message}</p></div>`;
        }
    }

    async resetInstance(instanceId, instanceName) {
        const modal = document.getElementById('qrModal');
        const instanceNameEl = document.getElementById('qrInstanceName');
        const qrContainer = document.getElementById('qrCodeContainer');

        this.currentQrInstance = { id: instanceId, name: instanceName };
        instanceNameEl.textContent = instanceName;
        
        // Limpar container
        qrContainer.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i><br>Reiniciando via WebSocket...</div>';
        
        // Mostrar modal
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';

        try {
            // Inscrever-se em eventos da instância via WebSocket
            this.subscribeToInstance(instanceId);
            
            // Resetar QR code via API
            await this.resetQrCode(instanceId);
            
            // Solicitar novo QR code via WebSocket
            this.requestQRCode(instanceId);
            
            // Solicitar status via WebSocket
            this.requestInstanceStatus(instanceId);
        } catch (error) {
            qrContainer.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Erro ao reiniciar conexão</p><p class="text-muted">${error.message}</p></div>`;
        }
    }

    async generateQrCode(instanceId) {
        const qrContainer = document.getElementById('qrCodeContainer');
        
        try {
            const response = await fetch(`${this.apiBaseUrl}/instance/${instanceId}/connect`, {
                method: 'POST'
            });

            const result = await response.json();

            if (response.ok && result.success) {
                // Conexão iniciada com sucesso - aguardar QR code via WebSocket
                console.log('✅ Conexão iniciada:', result.message);
                
                // Atualizar container para mostrar que está aguardando QR code
                qrContainer.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i><br>Aguardando QR Code via WebSocket...</div>';
                
                // O QR code virá via WebSocket, não pela resposta da API
                return;
            } else {
                throw new Error(result.message || 'Erro ao iniciar conexão');
            }
        } catch (error) {
            console.error('Erro ao gerar QR Code:', error);
            throw error;
        }
    }

    async resetQrCode(instanceId) {
        const qrContainer = document.getElementById('qrCodeContainer');
        
        try {
            const response = await fetch(`${this.apiBaseUrl}/instance/${instanceId}/reset`, {
                method: 'POST'
            });

            const result = await response.json();

            if (response.ok && result.data && result.data.qrCode) {
                // Debug: verificar o QR code recebido
                console.log('🔍 QR Code recebido da API (reset):', result.data.qrCode);
                console.log('🔍 Tipo do QR Code (reset):', typeof result.data.qrCode);
                
                // Extrair o QR code correto do objeto
                let qrCodeText;
                if (typeof result.data.qrCode === 'object' && result.data.qrCode.qr) {
                    qrCodeText = result.data.qrCode.qr;
                    console.log('🔍 QR Code extraído do objeto (reset):', qrCodeText);
                } else if (typeof result.data.qrCode === 'string') {
                    qrCodeText = result.data.qrCode;
                    console.log('🔍 QR Code como string (reset):', qrCodeText);
                } else {
                    throw new Error('Formato de QR Code inválido (reset)');
                }
                
                console.log('🔍 Tamanho do QR Code (reset):', qrCodeText.length);
                
                // Limpar container
                qrContainer.innerHTML = '';
                
                // Gerar QR Code visual
                const canvas = document.createElement('canvas');
                
                try {
                    console.log('🔍 Tentando gerar QR com ecLevel L (reset)...');
                    QrCreator.render({
                        text: qrCodeText,
                        radius: 0,
                        ecLevel: 'L',
                        fill: '#000000',
                        background: '#FFFFFF',
                        size: 300
                    }, canvas);
                    console.log('✅ QR Code gerado com sucesso (ecLevel L - reset)');
                } catch (error) {
                    // Fallback: tentar com configurações alternativas
                    console.warn('⚠️ Erro com ecLevel L (reset), tentando com ecLevel M:', error.message);
                    try {
                        QrCreator.render({
                            text: qrCodeText,
                            radius: 0,
                            ecLevel: 'M',
                            fill: '#000000',
                            background: '#FFFFFF',
                            size: 256
                        }, canvas);
                        console.log('✅ QR Code gerado com sucesso (ecLevel M - reset)');
                    } catch (fallbackError) {
                        console.error('❌ Erro mesmo com ecLevel M (reset):', fallbackError.message);
                        throw fallbackError;
                    }
                }
                
                qrContainer.appendChild(canvas);
                
                // Mostrar informações do QR code
                const infoContainer = document.createElement('div');
                infoContainer.className = 'qr-info';
                infoContainer.style.textAlign = 'center';
                infoContainer.style.marginTop = '15px';
                
                const resetText = document.createElement('p');
                resetText.className = 'text-success';
                resetText.innerHTML = '<i class="fas fa-sync-alt"></i> Novos QR Codes gerados!';
                infoContainer.appendChild(resetText);
                
                qrContainer.appendChild(infoContainer);
                
                this.currentQrData = qrCodeText;
            } else {
                throw new Error(result.message || 'Erro ao reiniciar conexão');
            }
        } catch (error) {
            console.error('Erro ao reiniciar conexão:', error);
            throw error;
        }
    }

    startQrCountdown(element, expiresAt) {
        // Limpar countdown anterior
        if (this.qrCountdownInterval) {
            clearInterval(this.qrCountdownInterval);
        }
        
        this.qrCountdownInterval = setInterval(() => {
            const now = new Date();
            const timeLeft = expiresAt.getTime() - now.getTime();
            
            if (timeLeft <= 0) {
                element.textContent = 'QR Code expirado - Aguardando novo...';
                element.style.color = '#dc3545';
                clearInterval(this.qrCountdownInterval);
            } else {
                const seconds = Math.ceil(timeLeft / 1000);
                element.textContent = `Expira em: ${seconds}s`;
                
                // Mudar cor quando restam poucos segundos
                if (seconds <= 10) {
                    element.style.color = '#dc3545';
                } else if (seconds <= 30) {
                    element.style.color = '#ffc107';
                } else {
                    element.style.color = '#6c757d';
                }
            }
        }, 1000);
    }

    startQrRefresh(instanceId) {
        // Limpar intervalo anterior
        if (this.qrRefreshInterval) {
            clearInterval(this.qrRefreshInterval);
        }

        // Nota: Monitoramento agora é feito via WebSocket, não mais por polling
        console.log('⚠️ startQrRefresh: Monitoramento agora é via WebSocket');

        // Atualizar QR a cada 30 segundos (mantido como fallback)
        this.qrRefreshInterval = setInterval(async () => {
            if (this.currentQrInstance && this.currentQrInstance.id === instanceId) {
                try {
                    // Solicitar novo QR via WebSocket primeiro
                    this.requestQRCode(instanceId);
                    
                    // Fallback via API
                    await this.generateQrCode(instanceId);
                } catch (error) {
                    console.error('Erro ao atualizar QR Code:', error);
                }
            }
        }, 30000);
    }

    // Método mantido para compatibilidade, mas não é mais usado
    startConnectionMonitoring(instanceId) {
        console.log('⚠️ startConnectionMonitoring: Substituído por WebSocket');
        // Método obsoleto - monitoramento agora é via WebSocket
        return;
    }

    handleSuccessfulConnection(instanceId) {
        // Cancelar inscrição em eventos da instância via WebSocket
        if (instanceId) {
            this.unsubscribeFromInstance(instanceId);
        }
        
        // Para todos os intervalos (mantido para compatibilidade)
        if (this.qrRefreshInterval) {
            clearInterval(this.qrRefreshInterval);
            this.qrRefreshInterval = null;
        }
        
        if (this.connectionMonitorInterval) {
            clearInterval(this.connectionMonitorInterval);
            this.connectionMonitorInterval = null;
        }
        
        // Atualiza status no modal com sucesso
        this.updateQrModalStatus('✅ Conectado com sucesso!', 'connected');
        
        // Mostra toast de sucesso
        this.showToast('WhatsApp conectado com sucesso!', 'success');
        
        // Atualiza imediatamente o status da instância na interface
        this.updateInstanceStatus('connected', instanceId);
        
        // Fecha o modal após 2 segundos
        setTimeout(() => {
            this.closeQrModal();
        }, 2000);
    }

    // Função para atualizar o status de uma instância específica na interface
    updateInstanceStatus(status, instanceId = null) {
        // Se instanceId não foi fornecido, usa a instância atual do QR
        const targetInstanceId = instanceId || (this.currentQrInstance ? this.currentQrInstance.id : null);
        
        if (!targetInstanceId) {
            console.warn('⚠️ Nenhuma instância especificada para atualizar status');
            return;
        }
        
        // Encontra o card da instância
        const instanceCard = document.querySelector(`[data-instance-id="${targetInstanceId}"]`);
        if (!instanceCard) {
            console.warn(`⚠️ Card da instância ${targetInstanceId} não encontrado`);
            return;
        }
        
        // Atualiza o status visual
        const statusElement = instanceCard.querySelector('.instance-status');
        if (statusElement) {
            statusElement.className = `instance-status ${this.getStatusClass(status)}`;
            statusElement.textContent = this.getStatusText(status);
        }
        
        // Atualiza o botão principal baseado no status
        const actionsContainer = instanceCard.querySelector('.instance-actions');
        if (actionsContainer && status === 'connected') {
            const connectBtn = actionsContainer.querySelector('.connect-btn');
            if (connectBtn) {
                connectBtn.outerHTML = `
                    <button class="btn btn-success" disabled>
                        <i class="fas fa-check-circle"></i> Conectado
                    </button>
                `;
            }
        } else if (actionsContainer && status === 'disconnected') {
            const connectedBtn = actionsContainer.querySelector('.btn-success[disabled]');
            if (connectedBtn) {
                const instanceName = instanceCard.querySelector('.instance-name').textContent;
                connectedBtn.outerHTML = `
                    <button class="btn btn-primary connect-btn" data-instance-id="${targetInstanceId}" data-instance-name="${this.escapeHtml(instanceName)}">
                        <i class="fas fa-plug"></i> Conectar
                    </button>
                `;
                // Re-bind events para o novo botão
                this.bindInstanceEvents();
            }
        }
        
        console.log(`✅ Status da instância ${targetInstanceId} atualizado para: ${status}`);
    }

    updateQrModalStatus(message, status) {
        const qrContainer = document.getElementById('qrCodeContainer');
        if (!qrContainer) {
            console.error('❌ Elemento qrCodeContainer não encontrado');
            return;
        }
        let statusElement = qrContainer.querySelector('.connection-status');
        
        if (!statusElement) {
            statusElement = document.createElement('div');
            statusElement.className = 'connection-status';
            statusElement.style.textAlign = 'center';
            statusElement.style.marginTop = '15px';
            statusElement.style.padding = '10px';
            statusElement.style.borderRadius = '5px';
            qrContainer.appendChild(statusElement);
        }
        
        statusElement.textContent = message;
        statusElement.className = `connection-status status-${status}`;
    }

    closeQrModal() {
        const modal = document.getElementById('qrModal');
        modal.classList.remove('show');
        document.body.style.overflow = '';
        
        // Cancelar inscrição em eventos da instância via WebSocket
        if (this.currentQrInstance) {
            this.unsubscribeFromInstance(this.currentQrInstance.id);
        }
        
        // Limpar intervalo de refresh (mantido para compatibilidade)
        if (this.qrRefreshInterval) {
            clearInterval(this.qrRefreshInterval);
            this.qrRefreshInterval = null;
        }
        
        // Limpar monitoramento de conexão (mantido para compatibilidade)
        if (this.connectionMonitorInterval) {
            clearInterval(this.connectionMonitorInterval);
            this.connectionMonitorInterval = null;
        }
        
        // Limpar countdown do QR
        if (this.qrCountdownInterval) {
            clearInterval(this.qrCountdownInterval);
            this.qrCountdownInterval = null;
        }
        
        // Desconectar do SSE (mantido para compatibilidade)
        this.disconnectFromSSE();
        
        this.currentQrInstance = null;
        this.currentQrData = null;
    }

    async regenerateQrCode() {
        if (!this.currentQrInstance) return;
        
        const regenerateBtn = document.getElementById('regenerateQr');
        const originalText = regenerateBtn.innerHTML;
        
        try {
            regenerateBtn.disabled = true;
            regenerateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Gerando...';
            
            // Solicitar novo QR code via WebSocket
            this.requestQRCode(this.currentQrInstance.id);
            
            // Fallback: gerar via API
            await this.generateQrCode(this.currentQrInstance.id);
            this.showToast('QR Code regenerado com sucesso!', 'success');
        } catch (error) {
            this.showToast(`Erro ao regenerar QR Code: ${error.message}`, 'error');
        } finally {
            regenerateBtn.disabled = false;
            regenerateBtn.innerHTML = originalText;
        }
    }

    downloadQrCode() {
        if (!this.currentQrData || !this.currentQrInstance) {
            this.showToast('Nenhum QR Code disponível para download', 'warning');
            return;
        }

        try {
            const canvas = document.createElement('canvas');
            
            const generateDownload = async () => {
                try {
                    QrCreator.render({
                        text: this.currentQrData,
                        radius: 0,
                        ecLevel: 'L',
                        fill: '#000000',
                        background: '#FFFFFF',
                        size: 512
                    }, canvas);
                } catch (error) {
                    console.warn('Tentando com configurações alternativas para download:', error.message);
                    QrCreator.render({
                        text: this.currentQrData,
                        radius: 0,
                        ecLevel: 'M',
                        fill: '#000000',
                        background: '#FFFFFF',
                        size: 256
                    }, canvas);
                }
            };
            
            generateDownload().then(() => {
                const link = document.createElement('a');
                link.download = `qrcode-${this.currentQrInstance.name.replace(/[^a-zA-Z0-9]/g, '_')}.png`;
                link.href = canvas.toDataURL();
                link.click();
                
                this.showToast('QR Code baixado com sucesso!', 'success');
            }).catch((error) => {
                console.error('Erro ao baixar QR Code:', error);
                this.showToast('Erro ao baixar QR Code', 'error');
            });
        } catch (error) {
            console.error('Erro ao baixar QR Code:', error);
            this.showToast('Erro ao baixar QR Code', 'error');
        }
    }

    async restartInstance(instanceId) {
        if (!confirm('Tem certeza que deseja reiniciar esta instância?')) {
            return;
        }

        try {
            const response = await fetch(`${this.apiBaseUrl}/instance/${instanceId}/restart`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            const result = await response.json();
            
            if (result.success) {
                this.showToast('Instância reiniciada com sucesso!', 'success');
                this.loadInstances();
            } else {
                this.showToast(`Erro ao reiniciar: ${result.error}`, 'error');
            }
        } catch (error) {
            console.error('Erro ao reiniciar instância:', error);
            this.showToast(`Erro ao reiniciar instância: ${error.message}`, 'error');
        }
    }

    async deleteInstance(instanceId, instanceName) {
        if (!confirm(`Tem certeza que deseja excluir a instância "${instanceName}"?\n\nEsta ação não pode ser desfeita.`)) {
            return;
        }

        try {
            const response = await fetch(`${this.apiBaseUrl}/instance/${instanceId}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            const result = await response.json();
            
            if (result.success) {
                this.showToast('Instância excluída com sucesso!', 'success');
                this.loadInstances();
            } else {
                this.showToast(`Erro ao excluir: ${result.error}`, 'error');
            }
        } catch (error) {
            console.error('Erro ao excluir instância:', error);
            this.showToast(`Erro ao excluir instância: ${error.message}`, 'error');
        }
    }

    getStatusClass(status) {
        const statusMap = {
            'connected': 'status-connected',
            'disconnected': 'status-disconnected',
            'connecting': 'status-connecting',
            'qr_code': 'status-connecting' // ✅ CORREÇÃO: Adicionado suporte para qr_code
        };
        return statusMap[status] || 'status-disconnected';
    }

    getStatusText(status) {
        const statusMap = {
            'connected': 'Conectado',
            'disconnected': 'Desconectado',
            'connecting': 'Conectando',
            'qr_code': 'QR Code Ativo' // ✅ CORREÇÃO: Adicionado suporte para qr_code
        };
        return statusMap[status] || 'Desconhecido';
    }

    showToast(message, type = 'info') {
        const toast = document.getElementById('toast');
        const toastMessage = document.getElementById('toastMessage');
        
        // Remover classes de tipo anteriores
        toast.classList.remove('success', 'error', 'warning', 'info');
        
        // Adicionar nova classe de tipo
        toast.classList.add(type);
        
        toastMessage.textContent = message;
        toast.classList.add('show');
        
        // Auto-hide após 5 segundos
        setTimeout(() => {
            this.hideToast();
        }, 5000);
    }

    hideToast() {
        const toast = document.getElementById('toast');
        toast.classList.remove('show');
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Método para obter o status atual de uma instância
    getCurrentInstanceStatus(instanceId) {
        const instance = this.instances.find(inst => inst.id === instanceId);
        return instance ? instance.status : null;
    }
}

// Inicializar aplicação quando DOM estiver carregado
document.addEventListener('DOMContentLoaded', () => {
    new WhatsAppManager();
});

// Adicionar service worker para PWA (opcional)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // Service worker pode ser implementado futuramente
    });
}