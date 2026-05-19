#!/bin/bash

echo "========================================"
echo "🔍 CERTIMOTORS PROJECT AUDIT"
echo "========================================"
echo ""

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

check_file() {
  if [ -f "$1" ]; then
    echo -e "${GREEN}✅${NC} $1"
  else
    echo -e "${RED}❌${NC} $1 (MISSING)"
  fi
}

check_dir() {
  if [ -d "$1" ]; then
    echo -e "${GREEN}✅${NC} $1/"
  else
    echo -e "${RED}❌${NC} $1/ (MISSING)"
  fi
}

echo "📁 DIRECTORY STRUCTURE"
echo "===================="
check_dir "src"
check_dir "tests"
check_dir "migrations"
check_dir "docs"
check_dir ".github/workflows"
check_dir "scripts"
echo ""

echo "📄 SOURCE FILES"
echo "==============="
check_file "src/index.js"
check_file "src/db.js"
check_file "src/prompts.js"
check_file "src/errors.js"
check_file "src/logger.js"
check_file "src/validators.js"
check_file "src/ratelimit.js"
echo ""

echo "📋 CONFIG FILES"
echo "==============="
check_file "package.json"
check_file ".env"
check_file ".gitignore"
check_file ".eslintrc.json"
check_file ".prettierrc"
check_file "Dockerfile"
check_file "railway.toml"
echo ""

echo "📚 DOCUMENTATION"
echo "================"
check_file "README.md"
check_file "docs/ROADMAP.md"
echo ""

echo "🧪 TESTING"
echo "=========="
check_file "tests/curl-commands.sh"
check_file "migrations/init.sql"
echo ""

echo "🔧 GITHUB WORKFLOWS"
echo "==================="
check_file ".github/workflows/test.yml"
check_file ".github/workflows/security.yml"
echo ""

echo "📦 NODE DEPENDENCIES"
echo "===================="
if [ -d "node_modules" ]; then
  COUNT=$(ls -1 node_modules | wc -l)
  echo -e "${GREEN}✅${NC} node_modules ($COUNT packages)"
else
  echo -e "${RED}❌${NC} node_modules (RUN: npm install)"
fi
echo ""

echo "💾 DATABASE"
echo "==========="
if [ -f "database.db" ]; then
  SIZE=$(ls -lh database.db | awk '{print $5}')
  echo -e "${GREEN}✅${NC} database.db ($SIZE)"
else
  echo -e "${YELLOW}⚠️ ${NC} database.db (será creada al iniciar)"
fi
echo ""

echo "🔐 ENVIRONMENT"
echo "==============="
if [ -f ".env" ]; then
  echo -e "${GREEN}✅${NC} .env exists"
else
  echo -e "${RED}❌${NC} .env missing"
fi
echo ""

echo "📊 GIT STATUS"
echo "============="
if git rev-parse --git-dir > /dev/null 2>&1; then
  echo -e "${GREEN}✅${NC} Git repository"
  COMMITS=$(git log --oneline | wc -l)
  echo "   Commits: $COMMITS"
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  echo "   Branch: $BRANCH"
else
  echo -e "${RED}❌${NC} No git repository"
fi
echo ""

echo "===============
