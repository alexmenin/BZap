# BZap - WhatsApp API

Uma API moderna e otimizada para integração com WhatsApp Web, construída com Node.js, TypeScript e React.

## 🚀 Características

- **API REST completa** para WhatsApp Web
- **Interface web moderna** para gerenciamento de instâncias
- **Geração de QR Code** otimizada e sem loops
- **Logs inteligentes** com controle de spam
- **Múltiplas instâncias** simultâneas
- **Autenticação persistente** com Baileys
- **WebSocket otimizado** com controle de eventos duplicados

## 🛠️ Tecnologias

### Backend
- **Node.js** com TypeScript
- **Express.js** para API REST
- **WebSocket** para comunicação em tempo real
- **Baileys** para integração WhatsApp
- **PostgreSQL** ready (configurável)

### Frontend
- **React** com Vite
- **Interface responsiva** e moderna
- **Gerenciamento de estado** otimizado
- **QR Code** em tempo real

## 📦 Instalação

```bash
# Clone o repositório
git clone https://github.com/seu-usuario/BZap.git
cd BZap

# Instale as dependências
npm install

# Configure as variáveis de ambiente
cp .env.example .env

# Compile o projeto
npm run build

# Inicie o servidor
npm start
```

## 🔧 Configuração

1. Copie o arquivo `.env.example` para `.env`
2. Configure as variáveis necessárias
3. Execute `npm run build` para compilar
4. Execute `npm start` para iniciar

## 📚 API Endpoints

### Instâncias
- `GET /api/instances` - Lista todas as instâncias
- `POST /api/instances` - Cria nova instância
- `GET /api/instances/:id/qr` - Obtém QR Code da instância
- `DELETE /api/instances/:id` - Remove instância

### QR Code
- `GET /api/qr/:instanceId` - QR Code em tempo real
- Interface web disponível em `/`

## 🎯 Otimizações Implementadas

### Controle de Logs
- ✅ Eliminação de loops de logs repetitivos
- ✅ QR Code exibido apenas uma vez por geração
- ✅ Controle de eventos 'close' duplicados
- ✅ Logs estruturados e informativos

### Performance
- ✅ WebSocket otimizado com flags de controle
- ✅ Gerenciamento eficiente de múltiplas instâncias
- ✅ Cache inteligente de sessões
- ✅ Reconexão automática com backoff

## 🔒 Segurança

- Autenticação segura com Baileys
- Gerenciamento de credenciais criptografadas
- Validação de entrada em todos os endpoints
- Logs sem exposição de dados sensíveis

## 📱 Interface Web

Acesse `http://localhost:3000` para:
- Gerenciar instâncias WhatsApp
- Visualizar QR Codes em tempo real
- Monitorar status de conexão
- Logs em tempo real

## 🤝 Contribuição

1. Fork o projeto
2. Crie uma branch para sua feature (`git checkout -b feature/AmazingFeature`)
3. Commit suas mudanças (`git commit -m 'Add some AmazingFeature'`)
4. Push para a branch (`git push origin feature/AmazingFeature`)
5. Abra um Pull Request

## 📄 Licença

Este projeto está sob a licença MIT. Veja o arquivo [LICENSE](LICENSE) para mais detalhes.

## 🙏 Agradecimentos

- [Baileys](https://github.com/WhiskeySockets/Baileys) - Biblioteca WhatsApp Web
- [WhiskeySockets](https://github.com/WhiskeySockets) - Manutenção do Baileys
- Comunidade open source

## 📞 Suporte

Para suporte e dúvidas:
- Abra uma [issue](https://github.com/seu-usuario/BZap/issues)
- Consulte a [documentação](https://github.com/seu-usuario/BZap/wiki)

---

⭐ **Se este projeto foi útil, considere dar uma estrela!**