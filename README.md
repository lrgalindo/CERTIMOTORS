# 🚀 CERTIMOTORS - Plataforma de Certificación Automotriz

**Status:** ✅ En Desarrollo | **Fase:** 1-2 | **Backend:** Express.js + Claude AI

## 📌 Overview

CERTIMOTORS es una plataforma inteligente para certificación de vehículos en Guatemala, con integración de Claude AI para procesamiento conversacional.

- **WhatsApp:** Interacción con clientes
- **Telegram:** Coordinación mecánicos + tramitadores
- **Claude AI:** Procesamiento inteligente de inspecciones
- **SQLite/Supabase:** Base de datos persistente

## 🚀 Quick Start

```bash
# Instalar
npm install

# Configurar
cp .env.example .env
nano .env  # Agregar ANTHROPIC_API_KEY

# Iniciar
npm start

# Health check
curl http://localhost:3000
```

## 📊 Endpoints

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/` | GET | Health check |
| `/metrics` | GET | Métricas del sistema |
| `/webhook/whatsapp` | POST | Webhook WhatsApp |
| `/webhook/telegram/mecanico` | POST | Webhook Telegram (mecánico) |
| `/webhook/telegram/tramitador` | POST | Webhook Telegram (tramitador) |
| `/api/validar-orden` | POST | Validar orden |
| `/api/reporte-diario` | POST | Reporte diario |

## 📚 Documentación

- [ROADMAP.md](docs/ROADMAP.md) - Timeline FASE 7-8 (Managed Agents)
- [FASES.md](docs/FASES.md) - Implementación FASE 1-6 (WIP)

## 🛠️ Stack

- **Backend:** Express.js (Node.js 18+)
- **Database:** SQLite (local) → Supabase (production)
- **AI:** Claude API (Messages API + Managed Agents)
- **Messaging:** WhatsApp Business API + Telegram Bot API
- **Deploy:** Railway.app
- **Code Quality:** ESLint + Prettier

## 📦 Dependencies

```bash
npm install
# express, axios, dotenv, sqlite3, uuid, compression
```

## 🧪 Testing

```bash
# Health check
npm start
curl http://localhost:3000

# Lint
npm run lint

# Format
npm run format

# Full test suite
bash tests/curl-commands.sh
```

## 🔐 Environment Variables

```env
PORT=3000
NODE_ENV=development
DATABASE_TYPE=sqlite
ANTHROPIC_API_KEY=sk-ant-api03-...
ANTHROPIC_MODEL=claude-opus-4-20250514
WHATSAPP_WEBHOOK_VERIFY_TOKEN=...
TELEGRAM_BOT_TOKEN=...
```

## 📋 Project Structure
certimotors-api/
├── src/
│   ├── index.js           # Backend principal
│   ├── db.js              # SQLite abstraction
│   ├── prompts.js         # System prompts (5)
│   ├── errors.js          # Error handling
│   ├── logger.js          # Logging
│   ├── validators.js      # Input validation
│   └── ratelimit.js       # Rate limiting
├── tests/
│   └── curl-commands.sh   # Testing script
├── migrations/
│   └── init.sql           # Supabase schema
├── docs/
│   ├── ROADMAP.md         # FASE 7-8 planning
│   └── FASES.md           # Implementation guide
├── scripts/
│   └── audit.sh           # Project audit
├── .github/
│   └── workflows/         # GitHub Actions
├── Dockerfile             # Container build
├── railway.toml           # Railway config
├── package.json           # Dependencies
├── .env.example           # Env template
└── README.md              # Este archivo
## 🚀 FASES

### FASE 1-6: Messages API (En progreso)
- ✅ Backend local (COMPLETADO)
- ✅ SQLite + tablas (COMPLETADO)
- ✅ Code quality + infraestructura (COMPLETADO)
- ⏳ Credenciales reales (PRÓXIMO)
- ⏳ Deploy Railway (PRÓXIMO)
- ⏳ Webhooks reales (PRÓXIMO)

### FASE 7-8: Managed Agents (Q3-Q4 2026)
Ver [ROADMAP.md](docs/ROADMAP.md) para detalles.

## 📈 Métricas

```bash
# Ver métricas en tiempo real
curl http://localhost:3000/metrics
```

## 🐛 Troubleshooting

### "Cannot find module 'express'"
```bash
npm install
```

### "ANTHROPIC_API_KEY is undefined"
```bash
# Editar .env y agregar tu API key
nano .env
```

### "SQLite database locked"
```bash
# Reiniciar servidor
npm start
```

## 👤 Author

Rodrigo Galindo (@lrgalindo)

## 📄 License

MIT

## 📞 Soporte

GitHub Issues: https://github.com/lrgalindo/CERTIMOTORS/issues

---

**Last updated:** May 18, 2026  
**Version:** 1.0.0  
**Status:** 🟡 In Development
