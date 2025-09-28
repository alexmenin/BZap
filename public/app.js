// app.js - Aplicação frontend para gerenciamento de instâncias WhatsApp

class WhatsAppManager {
    constructor() {
        this.apiBaseUrl = window.location.origin + '/api';
        this.instances = [];
        this.currentQrInstance = null;
        this.qrRefreshInterval = null;
        this.qrCountdownInterval = null;
        this.connectionMonitorInterval = null;
        
        this.init();
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
            name: formData.get('name'),
            webhookUrl: formData.get('webhookUrl') || undefined
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

        return `
            <div class="instance-card fade-in" data-instance-id="${instance.id}">
                <div class="instance-header">
                    <div class="instance-name">${this.escapeHtml(instance.name)}</div>
                    <div class="instance-status ${statusClass}">${statusText}</div>
                </div>
                <div class="instance-info">
                    <p><strong>ID:</strong> ${instance.id}</p>
                    <p><strong>Criado em:</strong> ${createdAt}</p>
                    ${instance.webhookUrl ? `<p><strong>Webhook:</strong> ${this.escapeHtml(instance.webhookUrl)}</p>` : ''}
                </div>
                <div class="instance-actions">
                    <button class="btn btn-primary qr-btn" data-instance-id="${instance.id}" data-instance-name="${this.escapeHtml(instance.name)}">
                        <i class="fas fa-qrcode"></i> QR Code
                    </button>
                    <button class="btn btn-warning restart-btn" data-instance-id="${instance.id}">
                        <i class="fas fa-redo"></i> Reiniciar
                    </button>
                    <button class="btn btn-danger delete-btn" data-instance-id="${instance.id}" data-instance-name="${this.escapeHtml(instance.name)}">
                        <i class="fas fa-trash"></i> Excluir
                    </button>
                </div>
            </div>
        `;
    }

    bindInstanceEvents() {
        // Botões de QR Code
        document.querySelectorAll('.qr-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const instanceId = e.target.closest('.qr-btn').dataset.instanceId;
                const instanceName = e.target.closest('.qr-btn').dataset.instanceName;
                this.showQrCode(instanceId, instanceName);
            });
        });

        // Botões de reiniciar
        document.querySelectorAll('.restart-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const instanceId = e.target.closest('.restart-btn').dataset.instanceId;
                this.restartInstance(instanceId);
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

    async showQrCode(instanceId, instanceName) {
        const modal = document.getElementById('qrModal');
        const instanceNameEl = document.getElementById('qrInstanceName');
        const qrContainer = document.getElementById('qrCodeContainer');

        this.currentQrInstance = { id: instanceId, name: instanceName };
        instanceNameEl.textContent = instanceName;
        
        // Limpar container
        qrContainer.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i><br>Gerando QR Code...</div>';
        
        // Mostrar modal
        modal.classList.add('show');
        document.body.style.overflow = 'hidden';

        try {
            await this.generateQrCode(instanceId);
            this.startQrRefresh(instanceId);
        } catch (error) {
            qrContainer.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Erro ao gerar QR Code</p><p class="text-muted">${error.message}</p></div>`;
        }
    }

    async generateQrCode(instanceId) {
        const qrContainer = document.getElementById('qrCodeContainer');
        
        try {
            const response = await fetch(`${this.apiBaseUrl}/qrcode/${instanceId}/generate`, {
                method: 'POST'
            });

            const result = await response.json();

            if (response.ok && result.data && result.data.qrCode) {
                // Limpar container
                qrContainer.innerHTML = '';
                
                // Gerar QR Code visual
                const canvas = document.createElement('canvas');
                
                try {
                    QrCreator.render({
                        text: result.data.qrCode,
                        radius: 0,
                        ecLevel: 'L',
                        fill: '#000000',
                        background: '#FFFFFF',
                        size: 300
                    }, canvas);
                } catch (error) {
                    // Fallback: tentar com configurações alternativas
                    console.warn('Tentando com configurações alternativas:', error.message);
                    QrCreator.render({
                        text: result.data.qrCode,
                        radius: 0,
                        ecLevel: 'M',
                        fill: '#000000',
                        background: '#FFFFFF',
                        size: 256
                    }, canvas);
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
                
                this.currentQrData = result.data.qrCode;
            } else {
                throw new Error(result.message || 'QR Code não encontrado na resposta');
            }
        } catch (error) {
            console.error('Erro ao gerar QR Code:', error);
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
                    const response = await fetch(`/api/qrcode/${instanceId}/status`);
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