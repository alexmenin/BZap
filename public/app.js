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
        
        this.init();
    }

    // Função para conectar ao SSE
    connectToSSE(instanceId) {
        // Fecha conexão anterior se existir
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }

        if (!instanceId) return;

        console.log(`🔌 Conectando ao SSE para instância: ${instanceId}`);
        
        this.eventSource = new EventSource(`/api/instance/${instanceId}/events`);

        this.eventSource.addEventListener('instance_status', (event) => {
            const data = JSON.parse(event.data);
            console.log('📊 Status inicial da instância:', data);
            
            if (data.qrCode) {
                this.updateQRCodeDisplay(data.qrCode);
            }
        });

        this.eventSource.addEventListener('qr_code', (event) => {
            const data = JSON.parse(event.data);
            console.log('📱 Novo QR code recebido via SSE:', data);
            
            this.updateQRCodeDisplay(data.qrCode);
        });

        this.eventSource.addEventListener('status_changed', (event) => {
            const data = JSON.parse(event.data);
            console.log('🔄 Status da instância alterado:', data);
            
            this.updateInstanceStatus(data.status);
        });

        this.eventSource.addEventListener('connected', (event) => {
            const data = JSON.parse(event.data);
            console.log('✅ Instância conectada:', data);
            
            this.handleSuccessfulConnection(instanceId);
        });

        this.eventSource.addEventListener('disconnected', (event) => {
            const data = JSON.parse(event.data);
            console.log('❌ Instância desconectada:', data);
            
            this.updateInstanceStatus('disconnected');
        });

        this.eventSource.addEventListener('heartbeat', (event) => {
            // Heartbeat silencioso para manter conexão
        });

        this.eventSource.onerror = (error) => {
            console.error('❌ Erro no SSE:', error);
            
            // Reconecta após 5 segundos em caso de erro
            setTimeout(() => {
                if (this.currentQrInstance && this.currentQrInstance.id) {
                    console.log('🔄 Tentando reconectar ao SSE...');
                    this.connectToSSE(this.currentQrInstance.id);
                }
            }, 5000);
        };
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
            if (!qrContainer) return;

            // Limpar container
            qrContainer.innerHTML = '';
            
            // Gerar QR Code visual
            const canvas = document.createElement('canvas');
            
            try {
                QrCreator.render({
                    text: qrCodeText,
                    radius: 0,
                    ecLevel: 'L',
                    fill: '#000000',
                    background: '#FFFFFF',
                    size: 300
                }, canvas);
                console.log('✅ QR Code gerado com sucesso via SSE');
            } catch (error) {
                // Fallback: tentar com configurações alternativas
                console.warn('⚠️ Erro com ecLevel L, tentando com ecLevel M:', error.message);
                QrCreator.render({
                    text: qrCodeText,
                    radius: 0,
                    ecLevel: 'M',
                    fill: '#000000',
                    background: '#FFFFFF',
                    size: 256
                }, canvas);
                console.log('✅ QR Code gerado com sucesso (ecLevel M) via SSE');
            }
            
            qrContainer.appendChild(canvas);
            
            // Mostrar informações do QR code
            const infoContainer = document.createElement('div');
            infoContainer.className = 'qr-info';
            infoContainer.style.textAlign = 'center';
            infoContainer.style.marginTop = '15px';
            
            const sseText = document.createElement('p');
            sseText.className = 'text-success';
            sseText.innerHTML = '<i class="fas fa-sync-alt"></i> QR Code atualizado automaticamente';
            infoContainer.appendChild(sseText);
            
            qrContainer.appendChild(infoContainer);
            
            console.log('✅ QR code atualizado com sucesso via SSE');

        } catch (error) {
            console.error('❌ Erro ao atualizar QR code:', error);
        }
    }

    // Função para desconectar do SSE
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
        qrContainer.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i><br>Conectando e gerando QR Codes...</div>';
        
        // Mostrar modal
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';

        try {
            await this.generateQrCode(instanceId);
            this.connectToSSE(instanceId);
            this.startConnectionMonitoring(instanceId);
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
        qrContainer.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i><br>Reiniciando conexão e gerando novos QR Codes...</div>';
        
        // Mostrar modal
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';

        try {
            await this.resetQrCode(instanceId);
            this.connectToSSE(instanceId);
            this.startConnectionMonitoring(instanceId);
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

            if (response.ok && result.data && result.data.qrCode) {
                // Debug: verificar o QR code recebido
                console.log('🔍 QR Code recebido da API:', result.data.qrCode);
                console.log('🔍 Tipo do QR Code:', typeof result.data.qrCode);
                
                // Extrair o QR code correto do objeto
                let qrCodeText;
                if (typeof result.data.qrCode === 'object' && result.data.qrCode.qr) {
                    qrCodeText = result.data.qrCode.qr;
                    console.log('🔍 QR Code extraído do objeto:', qrCodeText);
                } else if (typeof result.data.qrCode === 'string') {
                    qrCodeText = result.data.qrCode;
                    console.log('🔍 QR Code como string:', qrCodeText);
                } else {
                    throw new Error('Formato de QR Code inválido');
                }
                
                console.log('🔍 Tamanho do QR Code:', qrCodeText.length);
                
                // Limpar container
                qrContainer.innerHTML = '';
                
                // Gerar QR Code visual
                const canvas = document.createElement('canvas');
                
                try {
                    console.log('🔍 Tentando gerar QR com ecLevel L...');
                    QrCreator.render({
                        text: qrCodeText,
                        radius: 0,
                        ecLevel: 'L',
                        fill: '#000000',
                        background: '#FFFFFF',
                        size: 300
                    }, canvas);
                    console.log('✅ QR Code gerado com sucesso (ecLevel L)');
                } catch (error) {
                    // Fallback: tentar com configurações alternativas
                    console.warn('⚠️ Erro com ecLevel L, tentando com ecLevel M:', error.message);
                    try {
                        QrCreator.render({
                            text: qrCodeText,
                            radius: 0,
                            ecLevel: 'M',
                            fill: '#000000',
                            background: '#FFFFFF',
                            size: 256
                        }, canvas);
                        console.log('✅ QR Code gerado com sucesso (ecLevel M)');
                    } catch (fallbackError) {
                        console.error('❌ Erro mesmo com ecLevel M:', fallbackError.message);
                        throw fallbackError;
                    }
                }
                
                qrContainer.appendChild(canvas);
                
                // Mostrar informações do QR code
                const infoContainer = document.createElement('div');
                infoContainer.className = 'qr-info';
                infoContainer.style.textAlign = 'center';
                infoContainer.style.marginTop = '15px';
                
                // Mostrar progresso se disponível
                if (result.data.qrIndex !== undefined && result.data.qrTotal !== undefined) {
                    const progressText = document.createElement('p');
                    progressText.className = 'text-muted';
                    progressText.textContent = `QR Code ${result.data.qrIndex + 1} de ${result.data.qrTotal}`;
                    infoContainer.appendChild(progressText);
                }
                
                // Mostrar tempo de expiração
                if (result.data.expiresAt) {
                    const expiresAt = new Date(result.data.expiresAt);
                    const expiresText = document.createElement('p');
                    expiresText.className = 'text-muted';
                    expiresText.textContent = `Expira em: ${expiresAt.toLocaleString('pt-BR')}`;
                    infoContainer.appendChild(expiresText);
                    
                    // Adicionar countdown
                    this.startQrCountdown(expiresText, expiresAt);
                }
                
                qrContainer.appendChild(infoContainer);
                
                this.currentQrData = qrCodeText;
            } else {
                throw new Error(result.message || 'QR Code não encontrado na resposta');
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

        // Iniciar monitoramento de status da conexão
        this.startConnectionMonitoring(instanceId);

        // Atualizar QR a cada 30 segundos
        this.qrRefreshInterval = setInterval(async () => {
            if (this.currentQrInstance && this.currentQrInstance.id === instanceId) {
                try {
                    await this.generateQrCode(instanceId);
                } catch (error) {
                    console.error('Erro ao atualizar QR Code:', error);
                }
            }
        }, 30000);
    }

    startConnectionMonitoring(instanceId) {
        // Limpar monitoramento anterior
        if (this.connectionMonitorInterval) {
            clearInterval(this.connectionMonitorInterval);
        }

        // Verificar status da conexão a cada 2 segundos para resposta mais rápida
        this.connectionMonitorInterval = setInterval(async () => {
            if (this.currentQrInstance && this.currentQrInstance.id === instanceId) {
                try {
                    const response = await fetch(`/api/instance/${instanceId}`);
                    const result = await response.json();
                    
                    if (result.success && result.data) {
                        const status = result.data.status;
                        
                        // Se conectou com sucesso
                        if (status === 'connected') {
                            this.handleSuccessfulConnection(instanceId);
                            return;
                        }
                        
                        // Se QR code foi escaneado
                        if (status === 'qr_scanned') {
                            console.log('🎉 QR Code escaneado detectado no frontend!');
                            this.updateQrModalStatus('🎉 QR Code escaneado! Conectando...', 'connecting');
                        }
                        
                        // Se está conectando
                        if (status === 'connecting') {
                            console.log('🔄 Status connecting detectado no frontend');
                            this.updateQrModalStatus('🔄 Finalizando autenticação...', 'connecting');
                        }
                        
                        // Se desconectou inesperadamente
                        if (status === 'disconnected' && this.currentQrInstance.status !== 'disconnected') {
                            this.updateQrModalStatus('Desconectado', 'disconnected');
                        }
                    }
                } catch (error) {
                    console.error('Erro ao verificar status da conexão:', error);
                    this.updateQrModalStatus('Erro ao verificar conexão', 'error');
                }
            }
        }, 2000);
    }

    handleSuccessfulConnection(instanceId) {
        // Para todos os intervalos
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
        
        // Fecha o modal após 3 segundos
        setTimeout(() => {
            this.closeQrModal();
            // Atualiza a lista de instâncias
            this.loadInstances();
        }, 3000);
    }

    updateQrModalStatus(message, status) {
        const qrContainer = document.getElementById('qrContainer');
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
        
        // Limpar intervalo de refresh
        if (this.qrRefreshInterval) {
            clearInterval(this.qrRefreshInterval);
            this.qrRefreshInterval = null;
        }
        
        // Limpar monitoramento de conexão
        if (this.connectionMonitorInterval) {
            clearInterval(this.connectionMonitorInterval);
            this.connectionMonitorInterval = null;
        }
        
        // Limpar countdown do QR
        if (this.qrCountdownInterval) {
            clearInterval(this.qrCountdownInterval);
            this.qrCountdownInterval = null;
        }
        
        // Desconectar do SSE
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
            'connecting': 'status-connecting'
        };
        return statusMap[status] || 'status-disconnected';
    }

    getStatusText(status) {
        const statusMap = {
            'connected': 'Conectado',
            'disconnected': 'Desconectado',
            'connecting': 'Conectando'
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