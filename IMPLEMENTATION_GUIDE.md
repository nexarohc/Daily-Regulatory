# Daily Regulatory - Implementation & Operations Guide

## Executive Summary

**Daily Regulatory** is a production-ready enterprise platform providing real-time intelligence from 200+ global health authorities. This guide covers complete setup, deployment, operations, and monetization strategies.

---

## Part 1: SYSTEM ARCHITECTURE OVERVIEW

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLIENT LAYER                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  Web Browser     │  │  Mobile App      │  │  API Clients     │  │
│  │  (React/Vue)     │  │  (React Native)  │  │  (Webhooks)      │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘  │
└───────────┼──────────────────────┼──────────────────────┼──────────┘
            │                      │                      │
┌───────────┼──────────────────────┼──────────────────────┼──────────┐
│           │         CDN/CACHE LAYER (CloudFlare)        │          │
│           └──────────────┬───────────────────────────────┘          │
└────────────────────────┬─────────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────────────┐
│                     API GATEWAY LAYER                               │
│              (Rate Limiting, Auth, Load Balancing)                  │
└────────────────────────┬────────────────────────────────────────────┘
                         │
┌────────────────────────┴──────────────────────────────────────────┐
│                    APPLICATION LAYER                              │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │        Node.js/Express Microservices (Kubernetes)         │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐   │  │
│  │  │ Auth Service │  │ Update API   │  │ Analytics API │   │  │
│  │  └──────────────┘  └──────────────┘  └───────────────┘   │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐   │  │
│  │  │ Sync Service │  │ Alert Engine │  │Notification   │   │  │
│  │  └──────────────┘  └──────────────┘  └───────────────┘   │  │
│  └────────────────────────────────────────────────────────────┘  │
└────────────────────────┬─────────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
┌───────┴───────┐ ┌──────┴──────┐ ┌──────┴──────┐
│  PostgreSQL   │ │   Redis     │ │   RabbitMQ  │
│  (Primary DB) │ │  (Cache)    │ │  (Queues)   │
└───────────────┘ └─────────────┘ └─────────────┘

┌───────────────────────────────────────────────────────────────────┐
│              DATA SOURCE INTEGRATION LAYER                         │
│  FDA │ EMA │ PMDA │ NMPA │ Health Canada │ WHO │ +195 authorities │
└───────────────────────────────────────────────────────────────────┘
```

---

## Part 2: LOCAL DEVELOPMENT SETUP

### Prerequisites
- Node.js 18+ or Python 3.10+
- Docker & Docker Compose
- PostgreSQL 14+
- Redis 7+
- Git

### Step 1: Clone & Setup

```bash
# Clone repository
git clone https://github.com/your-org/daily-regulatory.git
cd daily-regulatory

# Setup local environment
cp .env.development .env
cp .env.example .env.local

# Install dependencies
npm install
# or
pip install -r requirements.txt

# Create .env file
cat > .env << EOF
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/daily_regulatory
DATABASE_POOL_SIZE=20

# Redis
REDIS_URL=redis://localhost:6379

# JWT & Auth
JWT_SECRET=$(openssl rand -base64 32)
REFRESH_SECRET=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(openssl rand -base64 32)

# API Keys (register these with respective authorities)
FDA_API_KEY=your_fda_key
EMA_API_KEY=your_ema_key
PMDA_API_KEY=your_pmda_key

# Email Service
SENDGRID_API_KEY=your_sendgrid_key
NOTIFICATION_EMAIL=alerts@dailyregulatory.com

# Environment
NODE_ENV=development
LOG_LEVEL=debug
PORT=3000
EOF
```

### Step 2: Start Local Services

```bash
# Using Docker Compose
docker-compose -f docker-compose.dev.yml up -d

# Check services are running
docker-compose ps

# View logs
docker-compose logs -f api
docker-compose logs -f postgres
docker-compose logs -f redis
```

### Step 3: Database Setup

```bash
# Run migrations
npm run db:migrate

# Seed initial data (authorities, users, etc.)
npm run db:seed

# Verify database
psql postgresql://user:password@localhost:5432/daily_regulatory

# Check tables created
\dt

# Exit psql
\q
```

### Step 4: Start Development Server

```bash
# Terminal 1: API Server
npm run dev

# Terminal 2: Data Sync Worker
npm run worker:sync

# Terminal 3: Notification Worker
npm run worker:notifications

# Terminal 4: Watch for file changes
npm run watch
```

### Step 5: Verify Installation

```bash
# Test API endpoint
curl http://localhost:3000/api/v1/health

# Should return:
# {"status": "ok", "timestamp": "2024-01-15T10:30:00Z"}

# Check Redis connection
redis-cli ping

# Check Database
npm run db:check
```

---

## Part 3: REAL HEALTH AUTHORITY INTEGRATION

### Integration Checklist

#### 1. FDA (Food & Drug Administration)

```javascript
// config/authorities/fda.js
module.exports = {
  id: 'fda-usa',
  name: 'FDA',
  country: 'United States',
  flag: '🇺🇸',
  region: 'americas',
  
  sources: [
    {
      type: 'rss',
      url: 'https://www.fda.gov/news-events/fda-newsroom/all-fda-newsroom',
      frequency: 15, // minutes
      category: 'general'
    },
    {
      type: 'api',
      url: 'https://api.fda.gov/drug/enforcement.json',
      frequency: 60,
      category: 'recalls',
      params: {
        limit: 100,
        skip: 0
      }
    },
    {
      type: 'api',
      url: 'https://api.fda.gov/drug/approval.json',
      frequency: 1440, // daily
      category: 'approvals'
    },
    {
      type: 'webhook',
      url: 'https://www.fda.gov/webhook-endpoint',
      events: ['drug_approval', 'recall', 'warning_letter']
    }
  ],
  
  mappings: {
    title: 'news_title', // RSS field -> our field
    description: 'news_summary',
    url: 'url',
    publishedDate: 'publish_date',
    updateType: (item) => {
      if (item.type === 'Recalls') return 'recall';
      if (item.type === 'Approval') return 'approval';
      return 'warning';
    }
  }
};

// Initialize FDA sync
const fdaSource = new AuthoritySource(fdaConfig);
fdaSource.start();
```

#### 2. EMA (European Medicines Agency)

```javascript
// config/authorities/ema.js
module.exports = {
  id: 'ema-eu',
  name: 'EMA',
  country: 'European Union',
  flag: '🇪🇺',
  region: 'europe',
  
  sources: [
    {
      type: 'rss',
      url: 'https://www.ema.europa.eu/en/medicines/rss',
      frequency: 30
    },
    {
      type: 'api',
      url: 'https://www.ema.europa.eu/en/medicines/search',
      frequency: 1440,
      method: 'POST',
      body: {
        filters: { status: 'approved' },
        sort: 'date_desc'
      }
    },
    {
      type: 'scrape',
      url: 'https://www.ema.europa.eu/en/human-regulatory/post-authorisation/pharmacovigilance',
      selectors: {
        title: 'h2.title',
        description: 'div.content',
        date: 'span.publish-date'
      },
      frequency: 360 // 6 hours
    }
  ]
};
```

#### 3. PMDA (Japan)

```javascript
// config/authorities/pmda.js
module.exports = {
  id: 'pmda-japan',
  name: 'PMDA',
  country: 'Japan',
  flag: '🇯🇵',
  region: 'asia',
  
  language: 'japanese',
  
  sources: [
    {
      type: 'rss',
      url: 'https://www.pmda.go.jp/english/news/rss_english.xml',
      frequency: 120
    },
    {
      type: 'scrape',
      url: 'https://www.pmda.go.jp/english/safety/approval-information/',
      useSelenium: true, // Page uses JavaScript
      frequency: 360,
      selectors: {
        items: 'tr.approval-row',
        title: 'td:nth-child(2)',
        date: 'td:nth-child(1)'
      }
    }
  ],
  
  processors: [
    'translate_to_english',
    'normalize_dates_jst',
    'extract_approval_numbers'
  ]
};
```

---

## Part 4: PRODUCTION DEPLOYMENT

### Step 1: Prepare for Production

```bash
# Security audit
npm audit
npm audit fix

# Run tests
npm test
npm run test:coverage

# Lint code
npm run lint
npm run lint:fix

# Build optimization
npm run build:production
```

### Step 2: Deploy to AWS/Azure/GCP

#### AWS ECS Deployment

```bash
# Build and push Docker image
docker build -t daily-regulatory:v1.0.0 .
docker tag daily-regulatory:v1.0.0 your-registry.dkr.ecr.us-east-1.amazonaws.com/daily-regulatory:v1.0.0
docker push your-registry.dkr.ecr.us-east-1.amazonaws.com/daily-regulatory:v1.0.0

# Update ECS task definition
aws ecs register-task-definition --cli-input-json file://task-definition.json

# Update ECS service
aws ecs update-service \
  --cluster daily-regulatory-cluster \
  --service daily-regulatory-api \
  --task-definition daily-regulatory:5
```

#### Kubernetes Deployment

```bash
# Create namespace
kubectl create namespace daily-regulatory

# Create secrets
kubectl create secret generic db-secrets \
  --from-literal=url=$DATABASE_URL \
  -n daily-regulatory

kubectl create secret generic jwt-secrets \
  --from-literal=secret=$JWT_SECRET \
  -n daily-regulatory

# Deploy application
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secrets.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/hpa.yaml

# Verify deployment
kubectl get pods -n daily-regulatory
kubectl get services -n daily-regulatory
kubectl logs -f deployment/daily-regulatory-api -n daily-regulatory
```

### Step 3: Infrastructure as Code

```terraform
# terraform/main.tf

provider "aws" {
  region = "us-east-1"
}

# RDS PostgreSQL Database
resource "aws_db_instance" "postgres" {
  allocated_storage    = 100
  engine              = "postgres"
  engine_version      = "14.5"
  instance_class      = "db.t3.medium"
  name                = "daily_regulatory"
  username            = var.db_username
  password            = var.db_password
  publicly_accessible = false
  
  backup_retention_period = 30
  backup_window          = "03:00-04:00"
  
  multi_az = true
  
  tags = {
    Name = "daily-regulatory-postgres"
  }
}

# ElastiCache Redis
resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "daily-regulatory-cache"
  engine              = "redis"
  node_type           = "cache.t3.small"
  num_cache_nodes     = 1
  parameter_group_name = "default.redis7"
  port                = 6379
  
  tags = {
    Name = "daily-regulatory-redis"
  }
}

# ECS Cluster
resource "aws_ecs_cluster" "main" {
  name = "daily-regulatory-cluster"
  
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# Application Load Balancer
resource "aws_lb" "main" {
  name            = "daily-regulatory-alb"
  load_balancer_type = "application"
  
  subnets = var.subnet_ids
  
  enable_deletion_protection = true
  
  tags = {
    Name = "daily-regulatory-alb"
  }
}

# Output
output "database_endpoint" {
  value = aws_db_instance.postgres.endpoint
}

output "redis_endpoint" {
  value = aws_elasticache_cluster.redis.cache_nodes[0].address
}

output "load_balancer_dns" {
  value = aws_lb.main.dns_name
}
```

---

## Part 5: MONITORING & OPERATIONS

### Setup Monitoring

```bash
# Install Prometheus
docker pull prom/prometheus
docker run -d \
  -p 9090:9090 \
  -v /path/to/prometheus.yml:/etc/prometheus/prometheus.yml \
  prom/prometheus

# Install Grafana
docker pull grafana/grafana
docker run -d \
  -p 3001:3000 \
  -e GF_SECURITY_ADMIN_PASSWORD=admin \
  grafana/grafana

# Install ELK Stack
docker pull docker.elastic.co/elasticsearch/elasticsearch:8.0.0
docker pull docker.elastic.co/kibana/kibana:8.0.0
```

### Key Monitoring Dashboards

```yaml
# Grafana Dashboard: Health Check
{
  "dashboard": {
    "title": "Daily Regulatory - System Health",
    "panels": [
      {
        "title": "API Request Rate",
        "targets": [
          {
            "expr": "rate(http_requests_total[5m])"
          }
        ]
      },
      {
        "title": "Database Query Time",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, db_query_duration_ms)"
          }
        ]
      },
      {
        "title": "Updates Ingested (per hour)",
        "targets": [
          {
            "expr": "increase(updates_ingested_total[1h])"
          }
        ]
      },
      {
        "title": "Data Source Sync Status",
        "targets": [
          {
            "expr": "authority_last_sync_timestamp"
          }
        ]
      }
    ]
  }
}
```

### Alerting Setup

```yaml
# alerting-rules.yaml
groups:
  - name: daily-regulatory
    interval: 30s
    rules:
      - alert: HighErrorRate
        expr: rate(http_errors_total[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"
          
      - alert: DataIngestionLag
        expr: time() - authority_last_sync_timestamp > 3600
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Data ingestion lag > 1 hour"
          
      - alert: DatabaseDown
        expr: pg_up == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "PostgreSQL database is down"
          
      - alert: RedisDown
        expr: redis_up == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Redis cache is down"
```

---

## Part 6: API USAGE EXAMPLES

### Example 1: Get Latest FDA Updates

```javascript
const axios = require('axios');

const API_KEY = 'your-api-key';
const BASE_URL = 'https://api.dailyregulatory.com/v1';

async function getFDAUpdates() {
  try {
    const response = await axios.get(`${BASE_URL}/updates`, {
      params: {
        authority_id: 'fda-usa',
        type: 'approval',
        severity: 'high',
        limit: 20,
        page: 1
      },
      headers: {
        'Authorization': `Bearer ${API_KEY}`
      }
    });
    
    console.log('FDA Updates:');
    response.data.data.forEach(update => {
      console.log(`
        Title: ${update.title}
        Type: ${update.type}
        Severity: ${update.severity}
        Published: ${update.published_date}
        URL: ${update.url}
      `);
    });
    
    return response.data;
  } catch (error) {
    console.error('Error fetching updates:', error.message);
  }
}

getFDAUpdates();
```

### Example 2: Real-time WebSocket Updates

```javascript
const io = require('socket.io-client');

const socket = io('https://api.dailyregulatory.com', {
  auth: {
    token: 'your-jwt-token'
  }
});

// Subscribe to updates
socket.emit('subscribe', {
  authorities: ['fda-usa', 'ema-eu'],
  types: ['recall', 'warning'],
  regions: ['americas', 'europe']
});

// Receive updates
socket.on('updates', (updates) => {
  updates.forEach(update => {
    console.log(`🚨 New ${update.type.toUpperCase()}: ${update.title}`);
    console.log(`   Authority: ${update.authority}`);
    console.log(`   Severity: ${update.severity}`);
    console.log(`   Details: ${update.description}`);
  });
});

// Handle disconnection
socket.on('disconnect', () => {
  console.log('Disconnected from updates service');
});
```

### Example 3: Set Up Custom Alerts

```javascript
const axios = require('axios');

async function setupCustomAlert() {
  const alertConfig = {
    authorities: ['fda-usa', 'ema-eu'],
    types: ['recall', 'warning'],
    regions: ['americas', 'europe'],
    severity_threshold: 'high',
    notification_method: 'email',
    webhook_url: 'https://your-domain.com/webhook/alerts'
  };
  
  try {
    const response = await axios.post(
      'https://api.dailyregulatory.com/v1/subscriptions',
      alertConfig,
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`
        }
      }
    );
    
    console.log('Alert configured:', response.data.id);
    return response.data;
  } catch (error) {
    console.error('Error setting up alert:', error.response?.data);
  }
}

setupCustomAlert();
```

---

## Part 7: MONETIZATION STRATEGY

### Pricing Tiers

```javascript
// config/pricing.js
const PRICING_TIERS = {
  free: {
    name: 'Free',
    monthlyPrice: 0,
    features: {
      maxApiCalls: 100,
      maxSavedAlerts: 1,
      dataRetention: 7, // days
      authorities: ['fda-usa', 'health-canada'],
      updateFrequency: 'daily',
      support: 'email'
    }
  },
  
  professional: {
    name: 'Professional',
    monthlyPrice: 49,
    annualPrice: 490,
    features: {
      maxApiCalls: 10000,
      maxSavedAlerts: 50,
      dataRetention: 90,
      authorities: 'all', // All 200+ authorities
      updateFrequency: 'real-time',
      support: 'priority-email',
      webhooks: true,
      customReports: true
    }
  },
  
  enterprise: {
    name: 'Enterprise',
    monthlyPrice: null, // Custom pricing
    features: {
      maxApiCalls: 'unlimited',
      maxSavedAlerts: 'unlimited',
      dataRetention: 'unlimited',
      authorities: 'all',
      updateFrequency: 'real-time',
      support: 'dedicated-account-manager',
      webhooks: true,
      customReports: true,
      apiSLA: '99.9%',
      dataExport: true,
      whiteLabelOption: true,
      customIntegrations: true
    }
  }
};

module.exports = PRICING_TIERS;
```

### Usage-Based Billing

```javascript
// service/billing.js
class BillingService {
  async trackUsage(userId, action, count = 1) {
    const currentMonth = new Date().toISOString().slice(0, 7);
    
    const usage = await db.query(`
      UPDATE user_usage 
      SET ${action}_count = ${action}_count + $1,
          updated_at = NOW()
      WHERE user_id = $2 AND month = $3
      RETURNING *
    `, [count, userId, currentMonth]);
    
    // Check if usage exceeds limits
    await this.checkLimits(userId, usage);
  }
  
  async checkLimits(userId, usage) {
    const user = await db.get('users', userId);
    const tier = PRICING_TIERS[user.subscription_tier];
    
    if (tier.maxApiCalls !== 'unlimited' && 
        usage.api_calls_count > tier.maxApiCalls) {
      // Notify user and offer upgrade
      await this.sendUpgradeNotification(user);
    }
  }
  
  async generateInvoice(userId, month) {
    const usage = await db.query(`
      SELECT * FROM user_usage 
      WHERE user_id = $1 AND month = $2
    `, [userId, month]);
    
    const user = await db.get('users', userId);
    const tier = PRICING_TIERS[user.subscription_tier];
    
    const overageCost = this.calculateOverage(usage, tier);
    const totalAmount = tier.monthlyPrice + overageCost;
    
    return {
      invoiceId: generateId(),
      userId,
      month,
      baseFee: tier.monthlyPrice,
      overageCharges: overageCost,
      total: totalAmount,
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status: 'draft'
    };
  }
}
```

---

## Part 8: TROUBLESHOOTING GUIDE

### Common Issues & Solutions

#### Issue: High Database Latency

```bash
# Diagnose
EXPLAIN ANALYZE SELECT * FROM regulatory_updates 
WHERE authority_id = 'fda-usa' 
AND published_date > NOW() - INTERVAL '7 days'
ORDER BY published_date DESC LIMIT 100;

# Solutions
-- Add index
CREATE INDEX idx_updates_authority_date 
ON regulatory_updates(authority_id, published_date DESC);

-- Archive old data
CREATE TABLE regulatory_updates_archive AS 
SELECT * FROM regulatory_updates 
WHERE published_date < NOW() - INTERVAL '1 year';

DELETE FROM regulatory_updates 
WHERE published_date < NOW() - INTERVAL '1 year';

-- Analyze table
ANALYZE regulatory_updates;
```

#### Issue: Memory Leak in Node.js Process

```bash
# Monitor heap
node --inspect app.js

# Use Chrome DevTools chrome://inspect

# Capture heap snapshot
node --heap-prof app.js

# Analyze profile
node --prof-process isolate-*.log > processed.txt

# Check for uncleared timers
grep -r "setInterval\|setTimeout" src/ | grep -v "clearInterval\|clearTimeout"
```

#### Issue: Data Sync Failures

```bash
# Check sync logs
docker logs daily-regulatory-sync-worker | grep ERROR

# Verify API credentials
curl -H "Authorization: Bearer $FDA_API_KEY" https://api.fda.gov/drug/enforcement.json

# Check data queue
redis-cli LLEN sync:queue

# Manually trigger sync
curl -X POST http://localhost:3000/admin/sync \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"authority_ids": ["fda-usa"]}'
```

---

## Part 9: SECURITY HARDENING

### Checklist

- [ ] Enable SSL/TLS (HTTPS only)
- [ ] Set up Web Application Firewall (WAF)
- [ ] Implement rate limiting per IP and API key
- [ ] Enable CORS properly
- [ ] Set security headers (CSP, X-Frame-Options, etc.)
- [ ] Encrypt sensitive data at rest
- [ ] Use environment variables for secrets
- [ ] Implement request signing for webhooks
- [ ] Enable audit logging
- [ ] Setup intrusion detection
- [ ] Regular penetration testing
- [ ] DDoS protection (Cloudflare, AWS Shield)

### Security Headers Configuration

```javascript
const helmet = require('helmet');

app.use(helmet());
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    scriptSrc: ["'self'"],
    imgSrc: ["'self'", "data:", "https:"],
  },
}));

app.use(helmet.referrerPolicy({ policy: "strict-origin-when-cross-origin" }));
app.use(helmet.frameguard({ action: "deny" }));
```

---

## Quick Reference

### Useful Commands

```bash
# Database
npm run db:migrate      # Run migrations
npm run db:seed        # Seed data
npm run db:backup      # Create backup
npm run db:restore     # Restore from backup

# Deployment
npm run build          # Build application
npm run test           # Run tests
npm run deploy:prod    # Deploy to production

# Monitoring
npm run logs           # View logs
npm run metrics        # View metrics
npm run health-check   # Check system health

# Development
npm run dev            # Start dev server
npm run watch          # Watch for changes
npm run lint           # Lint code
npm run format         # Format code
```

---

## Support Contacts

- **Technical Support**: support@dailyregulatory.com
- **Sales**: sales@dailyregulatory.com
- **Security Issues**: security@dailyregulatory.com
- **Status Page**: status.dailyregulatory.com
- **Documentation**: docs.dailyregulatory.com
