# 🗺️ CERTIMOTORS Roadmap

## 📌 Overview

CERTIMOTORS evoluciona en dos arquitecturas:

- **Messages API** → Single turn (10 segundos max)
- **Managed Agents** → Multi-turn (horas)

---

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
- **Success metric:** 100% daily reports automated, 0 manual QA

---

## 🛠️ Implementation Plan (FASE 7)

### Sprint 1: Research & Design (Week 1-2)
- [ ] Deep dive Managed Agents API documentation
- [ ] Design agent state schema (qué datos persisten)
- [ ] Design inspection checklist (110 puntos + validations)
- [ ] Proof of concept con toy agent

### Sprint 2: Backend Infrastructure (Week 3-4)
- [ ] Crear `src/agents/` directory
- [ ] Agent factory function
- [ ] State persistence layer (Supabase)
- [ ] Inspection validator (120 rules)

### Sprint 3: Integration (Week 5-6)
- [ ] WhatsApp → Managed Agent routing
- [ ] Telegram → Managed Agent routing
- [ ] End-to-end testing
- [ ] Performance testing (concurrent agents)

### Sprint 4: Polish & Launch (Week 7-8)
- [ ] Error handling & recovery
- [ ] Analytics & monitoring
- [ ] Documentation
- [ ] Beta testing con 10 usuarios

---

## 📈 Success Metrics

| Métrica | Target | Baseline |
|---------|--------|----------|
| Inspection completion rate | 95% | N/A |
| Avg time per inspection | 45 min | N/A |
| Agent error rate | < 1% | N/A |
| Customer satisfaction | 4.5/5 | N/A |
| Uptime | 99.9% | 99% |

---

## 💰 Cost Analysis

| Item | Monthly | Notes |
|------|---------|-------|
| Claude API (Agents) | $500-1000 | Depende volumen |
| Supabase | $100-200 | 10GB storage |
| Railway | $50-100 | Scaled compute |
| **Total** | **$650-1300** | Escalable |

---

## 🚨 Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Managed Agents API changes | Alto | Monitor Claude changelog monthly |
| State corruption | Alto | Daily backups + audit logs |
| High latency inspections | Medio | Async processing + progress indicator |
| Cost overruns | Medio | Rate limiting + budget alerts |

---

## 📚 References

- [Managed Agents API Documentation](https://docs.anthropic.com/agents)
- [CERTIMOTORS FASE 1-6 Implementation](/docs/FASES.md)
- Inspection checklist: `/specs/INSPECTION_110_POINTS.md` (TBD)

---

**Last updated:** May 18, 2026  
**Owner:** Rodrigo Galindo (@lrgalindo)  
**Status:** 🟡 In Planning
