# 🗺️ CERTIMOTORS Roadmap

## 📌 Overview

CERTIMOTORS evoluciona en dos arquitecturas:

- **Messages API** → Single turn (10 segundos max)
- **Managed Agents** → Multi-turn (horas)

## 📊 Timeline

### FASE 1-6: Messages API (ACTUAL)
- **Status:** En progreso
- **Rollout:** Mayo 2026
- **Scope:** WhatsApp, Telegram, webhooks, basic routing

### FASE 7: Managed Agents Pilot (Q3 2026)
- **Status:** Planificación
- **Scope:** UC1 (Inspección 110 puntos)
- **Timeline:** 6-8 semanas
- **Team:** 1 senior engineer + Rodrigo (PO)
- **Success metric:** 50+ inspecciones completadas

### FASE 8: Full Automation (Q4 2026)
- **Status:** Roadmap
- **Scope:** UC2 + UC3 (Reportes + QA)
- **Timeline:** 4-6 semanas
- **Success metric:** 100% daily reports automated

## 🛠️ Implementation Plan (FASE 7)

### Sprint 1: Research & Design (Week 1-2)
- [ ] Deep dive Managed Agents API
- [ ] Design agent state schema
- [ ] Design inspection checklist
- [ ] POC con toy agent

### Sprint 2: Backend Infrastructure (Week 3-4)
- [ ] Crear src/agents/
- [ ] Agent factory function
- [ ] State persistence layer
- [ ] Inspection validator

### Sprint 3: Integration (Week 5-6)
- [ ] WhatsApp → Managed Agent routing
- [ ] Telegram → Managed Agent routing
- [ ] End-to-end testing
- [ ] Performance testing

### Sprint 4: Polish & Launch (Week 7-8)
- [ ] Error handling
- [ ] Analytics & monitoring
- [ ] Documentation
- [ ] Beta testing

## 📈 Success Metrics

| Métrica | Target |
|---------|--------|
| Inspection completion rate | 95% |
| Avg time per inspection | 45 min |
| Agent error rate | < 1% |
| Customer satisfaction | 4.5/5 |
| Uptime | 99.9% |

## 💰 Cost Analysis

| Item | Monthly |
|------|---------|
| Claude API (Agents) | $500-1000 |
| Supabase | $100-200 |
| Railway | $50-100 |
| **Total** | **$650-1300** |

## 📚 References

- [Managed Agents API](https://docs.anthropic.com/agents)
- [CERTIMOTORS FASE 1-6](/)

---

**Owner:** Rodrigo Galindo  
**Status:** 🟡 In Planning
