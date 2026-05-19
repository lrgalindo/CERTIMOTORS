#!/bin/bash

BASE_URL="http://localhost:3000"

echo "================================"
echo "🧪 CERTIMOTORS - Testing Script"
echo "================================"
echo ""

echo "1️⃣  Health Check"
echo "GET $BASE_URL/"
curl -s "$BASE_URL/" | jq '.'
echo ""
echo ""

echo "2️⃣  Métricas"
echo "GET $BASE_URL/metrics"
curl -s "$BASE_URL/metrics" | jq '.'
echo ""
echo ""

echo "3️⃣  Test WhatsApp Simulado"
echo "POST $BASE_URL/webhook/whatsapp"
curl -s -X POST "$BASE_URL/webhook/whatsapp" \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "changes": [{
        "value": {
          "messages": [{
            "from": "50231234567",
            "text": { "body": "Hola, quiero certificar mi auto placa P926FTB" }
          }]
        }
      }]
    }]
  }' | jq '.'
echo ""
echo ""

echo "4️⃣  Test Telegram Mecánico"
echo "POST $BASE_URL/webhook/telegram/mecanico"
curl -s -X POST "$BASE_URL/webhook/telegram/mecanico" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "El motor se ve en buen estado",
    "telegram_id": 123456789,
    "placa": "P926FTB",
    "punto_actual": 1
  }' | jq '.'
echo ""
echo ""

echo "5️⃣  Test Validación de Orden"
echo "POST $BASE_URL/api/validar-orden"
curl -s -X POST "$BASE_URL/api/validar-orden" \
  -H "Content-Type: application/json" \
  -d '{
    "placa": "P926FTB"
  }' | jq '.'
echo ""
echo ""

echo "✅ Testing completado"
