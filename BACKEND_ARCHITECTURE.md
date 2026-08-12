# Daily Regulatory - Complete Backend Architecture & Integration Guide

## Overview
Daily Regulatory is an enterprise-grade platform providing real-time regulatory intelligence from 200+ global health authorities. This document outlines the complete architecture, API specifications, database schema, and integration with real regulatory data sources.

---

## 1. TECHNOLOGY STACK

### Backend
- **Runtime**: Node.js 18+ or Python 3.10+
- **Framework**: Express.js (Node) or FastAPI (Python)
- **Database**: PostgreSQL (primary) + Redis (caching)
- **Message Queue**: RabbitMQ or Kafka (for real-time updates)
- **Authentication**: JWT + OAuth2
- **API Documentation**: Swagger/OpenAPI 3.0

### Infrastructure
- **Deployment**: Docker + Kubernetes
- **CDN**: CloudFlare for global distribution
- **Monitoring**: Prometheus + Grafana
- **Logging**: ELK Stack (Elasticsearch, Logstash, Kibana)

---

## 2. DATABASE SCHEMA

### PostgreSQL Tables

```sql
-- Users Table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    organization VARCHAR(255),
    role ENUM('admin', 'analyst', 'subscriber') DEFAULT 'subscriber',
    subscription_tier ENUM('free', 'professional', 'enterprise') DEFAULT 'free',
    api_key VARCHAR(255) UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP,
    is_active BOOLEAN DEFAULT true,
    CONSTRAINT password_length CHECK (length(password_hash) > 0)
);

-- Regulatory Updates Table
CREATE TABLE regulatory_updates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    authority_id UUID NOT NULL REFERENCES authorities(id),
    title VARCHAR(500) NOT NULL,
    description TEXT,
    update_type ENUM('approval', 'warning', 'recall', 'guidance', 'inspection', 'enforcement') NOT NULL,
    content_full TEXT,
    url VARCHAR(500),
    source_id VARCHAR(255),
    severity ENUM('critical', 'high', 'medium', 'low') DEFAULT 'medium',
    affected_products TEXT[],
    affected_regions VARCHAR(255)[],
    published_date TIMESTAMP NOT NULL,
    ingested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_processed BOOLEAN DEFAULT false,
    ai_summary TEXT,
    tags VARCHAR(255)[],
    INDEX idx_authority_published (authority_id, published_date),
    INDEX idx_severity (severity),
    INDEX idx_update_type (update_type),
    FULLTEXT INDEX ft_search (title, description)
);

-- Health Authorities Table
CREATE TABLE authorities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    country_code VARCHAR(2) NOT NULL,
    country_name VARCHAR(255) NOT NULL,
    region ENUM('americas', 'europe', 'asia', 'africa', 'oceania') NOT NULL,
    flag_emoji VARCHAR(10),
    website_url VARCHAR(500),
    rss_feed_url VARCHAR(500),
    api_endpoint VARCHAR(500),
    api_key VARCHAR(500), -- Encrypted in production
    data_format ENUM('rss', 'json', 'xml', 'html_scrape') DEFAULT 'rss',
    last_sync TIMESTAMP,
    sync_frequency_minutes INT DEFAULT 60,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_authority UNIQUE (country_code, name)
);

-- User Alerts & Subscriptions
CREATE TABLE user_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    authority_ids UUID[] NOT NULL,
    update_types VARCHAR(255)[] DEFAULT ARRAY['approval', 'warning', 'recall'],
    regions VARCHAR(255)[],
    severity_threshold ENUM('critical', 'high', 'medium', 'low') DEFAULT 'medium',
    notification_method ENUM('email', 'sms', 'webhook', 'in_app') DEFAULT 'email',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- API Usage Logs
CREATE TABLE api_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    api_key VARCHAR(255),
    endpoint VARCHAR(255),
    method VARCHAR(10),
    status_code INT,
    response_time_ms INT,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_date (user_id, created_at),
    INDEX idx_api_key (api_key)
);

-- Audit Log
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    action VARCHAR(255),
    resource_type VARCHAR(100),
    resource_id VARCHAR(255),
    changes JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_action (user_id, action)
);
```

---

## 3. CORE API ENDPOINTS

### Authentication Endpoints

```
POST /api/v1/auth/register
- Body: { email, password, fullName, organization }
- Response: { userId, token, refreshToken }
- Auth: None

POST /api/v1/auth/login
- Body: { email, password }
- Response: { userId, token, refreshToken, expiresIn }
- Auth: None

POST /api/v1/auth/refresh
- Body: { refreshToken }
- Response: { token, expiresIn }
- Auth: None

POST /api/v1/auth/logout
- Response: { success: true }
- Auth: JWT Bearer Token

POST /api/v1/auth/verify-email
- Body: { token }
- Response: { success: true }
- Auth: None
```

### Regulatory Updates Endpoints

```
GET /api/v1/updates
- Query Params: 
  - page (default: 1)
  - limit (default: 20, max: 100)
  - authority_id
  - type (approval|warning|recall|guidance)
  - region (americas|europe|asia|africa|oceania)
  - severity (critical|high|medium|low)
  - date_from (ISO 8601)
  - date_to (ISO 8601)
  - search (full text search)
- Response: { 
    data: [{ id, title, description, authority, type, severity, published_date }],
    pagination: { total, page, limit, pages }
  }
- Auth: JWT Bearer Token

GET /api/v1/updates/:id
- Response: { 
    id, title, description, authority, type, severity, 
    content_full, affected_products, affected_regions, url,
    ai_summary, tags, published_date
  }
- Auth: JWT Bearer Token

GET /api/v1/updates/feed/real-time
- Query Params: authorities (comma-separated IDs), types, regions
- Response: WebSocket connection for real-time updates
- Auth: JWT Bearer Token

POST /api/v1/updates/:id/bookmark
- Response: { success: true }
- Auth: JWT Bearer Token

GET /api/v1/updates/trending
- Query Params: days (default: 7), limit (default: 10)
- Response: { data: [{ title, authority, count, trend }] }
- Auth: JWT Bearer Token
```

### Authorities Endpoints

```
GET /api/v1/authorities
- Query Params: region, is_active
- Response: { 
    data: [{ id, name, country, region, flag, website_url, last_sync }]
  }
- Auth: JWT Bearer Token

GET /api/v1/authorities/:id
- Response: { 
    id, name, country, region, website_url, 
    update_count, last_updates: [...]
  }
- Auth: JWT Bearer Token

GET /api/v1/authorities/:id/statistics
- Query Params: days (default: 30)
- Response: { 
    total_updates, updates_by_type: {}, 
    updates_by_severity: {}, avg_processing_time_ms
  }
- Auth: JWT Bearer Token
```

### Subscription & Alert Endpoints

```
POST /api/v1/subscriptions
- Body: { authorities: [], types: [], regions: [], notification_method }
- Response: { id, created_at }
- Auth: JWT Bearer Token

GET /api/v1/subscriptions
- Response: { data: [{ id, authorities, types, regions, notification_method }] }
- Auth: JWT Bearer Token

PUT /api/v1/subscriptions/:id
- Body: { authorities: [], types: [], regions: [], notification_method }
- Response: { success: true, updated_at }
- Auth: JWT Bearer Token

DELETE /api/v1/subscriptions/:id
- Response: { success: true }
- Auth: JWT Bearer Token

GET /api/v1/alerts
- Query Params: page, limit, is_read
- Response: { data: [{ id, update_id, received_at, read_at }] }
- Auth: JWT Bearer Token

PUT /api/v1/alerts/:id/read
- Response: { success: true }
- Auth: JWT Bearer Token
```

### Analytics Endpoints

```
GET /api/v1/analytics/dashboard
- Query Params: days (default: 30)
- Response: { 
    total_updates, updates_today, critical_alerts, 
    top_authorities, updates_by_type, updates_by_severity,
    trending_products, trending_keywords
  }
- Auth: JWT Bearer Token

GET /api/v1/analytics/search-analytics
- Query Params: days, limit
- Response: { 
    data: [{ query, count, avg_results, popular_filters }]
  }
- Auth: JWT Bearer Token

POST /api/v1/analytics/export
- Body: { format: 'csv'|'pdf'|'json', filters: {...} }
- Response: { download_url, expires_in_hours: 24 }
- Auth: JWT Bearer Token
```

---

## 4. REAL HEALTH AUTHORITY DATA SOURCES

### Primary Global Sources

#### 1. FDA (United States)
```
Endpoints:
- Main RSS: https://www.fda.gov/news-events/fda-newsroom/all-fda-newsroom
- Recalls: https://www.accessdata.fda.gov/scripts/ires.cfm
- Drug Approvals: https://www.fda.gov/drugs/drug-approvals-and-databases
- JSON API: https://api.fda.gov/

Integration Pattern:
- Real-time pull from RSS feeds (every 15 minutes)
- Webhook subscriptions for critical approvals
- Direct API calls for detailed drug/device data
```

#### 2. EMA (European Medicines Agency)
```
Endpoints:
- EPAR RSS: https://www.ema.europa.eu/en/medicines/rss
- Signals & Safety: https://www.ema.europa.eu/en/human-regulatory/post-authorisation/pharmacovigilance
- Decision API: https://www.ema.europa.eu/en/medicines-search

Integration Pattern:
- RSS feed ingestion (hourly)
- XHTML parsing for safety alerts
- Weekly integration of decision summaries
```

#### 3. PMDA (Japan)
```
Endpoints:
- Approvals: https://www.pmda.go.jp/english/files/user/docs/
- Safety Alerts: https://www.pmda.go.jp/english/safety/
- JSON Feed: https://api.pmda.go.jp/docs/

Integration Pattern:
- HTML scraping with Selenium for Japanese regulatory notices
- Weekly report ingestion
- Email subscription webhook
```

#### 4. NMPA (China)
```
Endpoints:
- News Release: http://www.nmpa.gov.cn/
- Drug Approval List: http://www.nmpa.gov.cn/xlyz/ylqx/

Integration Pattern:
- Chinese language NLP parsing
- Weekly HTML scraping
- Official XML feed subscription
```

#### 5. Health Canada
```
Endpoints:
- Recalls: https://www.healthycanadians.gc.ca/recall-alert/recalls
- Authorized Drugs: https://www.canada.ca/en/health-canada/services
- API: https://api.health.canada.ca/

Integration Pattern:
- Real-time RSS feeds
- Direct database queries via API
- Email alert subscriptions
```

#### 6. WHO (World Health Organization)
```
Endpoints:
- Disease Outbreak News: https://www.who.int/news/disease-outbreak-news
- Global Alert Response: https://www.who.int/csr/don

Integration Pattern:
- RSS feed ingestion
- Email subscription parsing
- Alerts correlation across regional authorities
```

### Data Aggregation Logic

```javascript
// Example: Multi-source data ingestion pipeline
class RegulatoryDataAggregator {
  constructor(authorities, updateQueue) {
    this.authorities = authorities;
    this.queue = updateQueue;
  }

  async syncAllAuthorities() {
    const promises = this.authorities
      .filter(a => a.is_active)
      .map(authority => this.syncAuthority(authority));
    
    return Promise.allSettled(promises);
  }

  async syncAuthority(authority) {
    try {
      let updates = [];
      
      switch(authority.data_format) {
        case 'rss':
          updates = await this.fetchRSSFeed(authority);
          break;
        case 'json':
          updates = await this.fetchJSONAPI(authority);
          break;
        case 'xml':
          updates = await this.fetchXMLFeed(authority);
          break;
        case 'html_scrape':
          updates = await this.scrapHTML(authority);
          break;
      }

      // Deduplicate using source_id
      const newUpdates = await this.deduplicateUpdates(updates);
      
      // Process and enrich data
      const processed = await this.processUpdates(newUpdates, authority);
      
      // Queue for database insertion
      for (const update of processed) {
        await this.queue.push({
          type: 'SAVE_UPDATE',
          payload: update,
          timestamp: Date.now()
        });
      }

      // Update sync status
      await this.updateAuthoritySyncStatus(authority);
      
      return { authority: authority.name, count: processed.length };
    } catch (error) {
      console.error(`Failed to sync ${authority.name}:`, error);
      throw error;
    }
  }

  async fetchRSSFeed(authority) {
    const feed = await FeedParser.parse(authority.rss_feed_url);
    return feed.items.map(item => ({
      source_id: item.guid || item.link,
      title: item.title,
      description: item.description,
      url: item.link,
      published_date: new Date(item.pubDate),
      content_full: item.content,
      authority_id: authority.id
    }));
  }

  async processUpdates(updates, authority) {
    return Promise.all(updates.map(async (update) => {
      // AI-powered classification and summarization
      const classified = await this.classifyUpdate(update);
      const summary = await this.generateAISummary(update.content_full);
      const keywords = await this.extractKeywords(update);

      return {
        ...update,
        update_type: classified.type,
        severity: classified.severity,
        affected_products: classified.products,
        affected_regions: classified.regions,
        ai_summary: summary,
        tags: keywords,
        is_processed: true
      };
    }));
  }

  async classifyUpdate(update) {
    // Use ML model to classify type and severity
    // Example: if text contains "recall", set type='recall' and severity='high'
    const text = `${update.title} ${update.description}`.toLowerCase();
    
    const typeScores = {
      'recall': text.match(/recall|withdrawn/gi)?.length || 0,
      'warning': text.match(/warning|alert|caution/gi)?.length || 0,
      'approval': text.match(/approved|authorized|cleared/gi)?.length || 0,
      'guidance': text.match(/guidance|recommendation|guideline/gi)?.length || 0,
    };

    const type = Object.keys(typeScores).reduce((a, b) => 
      typeScores[a] > typeScores[b] ? a : b
    );

    const severity = typeScores[type] > 5 ? 'critical' : 
                     typeScores[type] > 3 ? 'high' : 
                     typeScores[type] > 1 ? 'medium' : 'low';

    return { type, severity };
  }

  async extractKeywords(update) {
    // Extract product names, drugs, diseases from update
    // Can use NLP library like natural.js or cloud service
    return [];
  }
}
```

---

## 5. REAL-TIME UPDATE SYSTEM

### WebSocket Implementation

```javascript
class RealtimeUpdateManager {
  constructor(io, db, authoritySync) {
    this.io = io;
    this.db = db;
    this.authoritySync = authoritySync;
    this.userSubscriptions = new Map();
  }

  initialize() {
    this.io.on('connection', (socket) => {
      socket.on('subscribe', (data) => {
        this.subscribeUser(socket.id, data);
      });

      socket.on('disconnect', () => {
        this.userSubscriptions.delete(socket.id);
      });
    });

    // Poll for new updates every 2 minutes
    setInterval(() => this.broadcastNewUpdates(), 120000);
  }

  subscribeUser(socketId, { authorities, types, regions }) {
    this.userSubscriptions.set(socketId, {
      authorities: new Set(authorities),
      types: new Set(types),
      regions: new Set(regions)
    });
  }

  async broadcastNewUpdates() {
    const lastUpdate = await this.db.query(
      'SELECT MAX(published_date) as max_date FROM regulatory_updates'
    );
    const since = new Date(lastUpdate[0].max_date);

    const newUpdates = await this.db.query(
      `SELECT * FROM regulatory_updates 
       WHERE published_date > $1 
       ORDER BY published_date DESC 
       LIMIT 100`,
      [since]
    );

    this.userSubscriptions.forEach((subscription, socketId) => {
      const relevantUpdates = newUpdates.filter(update => 
        subscription.authorities.has(update.authority_id) &&
        subscription.types.has(update.update_type) &&
        subscription.regions.has(update.affected_regions[0])
      );

      if (relevantUpdates.length > 0) {
        this.io.to(socketId).emit('updates', relevantUpdates);
      }
    });
  }
}
```

---

## 6. AUTHENTICATION & SECURITY

### JWT Token Strategy

```javascript
const jwt = require('jsonwebtoken');

class AuthenticationService {
  generateTokens(userId, email) {
    const accessToken = jwt.sign(
      { userId, email, type: 'access' },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    const refreshToken = jwt.sign(
      { userId, type: 'refresh' },
      process.env.REFRESH_SECRET,
      { expiresIn: '7d' }
    );

    return { accessToken, refreshToken };
  }

  verifyToken(token) {
    try {
      return jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      throw new Error('Invalid token');
    }
  }
}

// Middleware
const authenticateRequest = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (error) {
    res.status(403).json({ error: 'Invalid token' });
  }
};
```

### Password Security

```javascript
const bcrypt = require('bcrypt');

class PasswordService {
  async hashPassword(password) {
    const salt = await bcrypt.genSalt(12);
    return bcrypt.hash(password, salt);
  }

  async verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
  }
}
```

---

## 7. CACHING STRATEGY

### Redis Implementation

```javascript
class CacheManager {
  constructor(redis) {
    this.redis = redis;
  }

  async cacheUpdates(updates, ttlSeconds = 3600) {
    const key = 'updates:latest';
    await this.redis.setex(
      key,
      ttlSeconds,
      JSON.stringify(updates)
    );
  }

  async getUpdates() {
    const cached = await this.redis.get('updates:latest');
    return cached ? JSON.parse(cached) : null;
  }

  async invalidateCache(pattern) {
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  // Cache subscription results
  async getUserSubscriptions(userId, ttlSeconds = 1800) {
    const key = `subscriptions:${userId}`;
    const cached = await this.redis.get(key);
    
    if (cached) return JSON.parse(cached);
    
    // Fetch from DB and cache
    const data = await db.getUserSubscriptions(userId);
    await this.redis.setex(key, ttlSeconds, JSON.stringify(data));
    return data;
  }
}
```

---

## 8. DEPLOYMENT CHECKLIST

### Pre-Deployment
- [ ] Environment variables configured (.env file)
- [ ] Database migrations run
- [ ] SSL certificates installed
- [ ] Rate limiting configured
- [ ] CORS policies set
- [ ] API key generation system ready
- [ ] Webhook signing secrets generated
- [ ] Email service (SendGrid/AWS SES) configured

### Docker Deployment

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
```

### Kubernetes Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: daily-regulatory-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: daily-regulatory-api
  template:
    metadata:
      labels:
        app: daily-regulatory-api
    spec:
      containers:
      - name: api
        image: daily-regulatory:latest
        ports:
        - containerPort: 3000
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: db-secrets
              key: url
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: jwt-secrets
              key: secret
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 5
```

---

## 9. MONITORING & ALERTING

### Key Metrics to Track

```javascript
const metrics = {
  // Data ingestion
  'updates.ingested.count': Counter,
  'updates.ingestion.latency_ms': Histogram,
  'authority.sync.failures': Counter,
  
  // API Performance
  'api.request.duration_ms': Histogram,
  'api.request.count': Counter,
  'api.error.count': Counter,
  
  // Database
  'db.query.duration_ms': Histogram,
  'db.connections.active': Gauge,
  
  // WebSocket
  'ws.connections.active': Gauge,
  'ws.messages.sent': Counter,
  
  // Cache
  'cache.hit_rate': Gauge,
  'cache.evictions': Counter
};
```

### Alert Rules (Prometheus)

```yaml
groups:
  - name: daily-regulatory-alerts
    rules:
    - alert: DataIngestionFailure
      expr: rate(authority_sync_failures_total[5m]) > 0.1
      for: 10m
      annotations:
        summary: "Data ingestion failure rate too high"
    
    - alert: APIErrorRate
      expr: rate(api_errors_total[5m]) / rate(api_requests_total[5m]) > 0.05
      for: 5m
      annotations:
        summary: "API error rate exceeds 5%"
    
    - alert: DatabaseLatency
      expr: histogram_quantile(0.95, db_query_duration_ms) > 500
      for: 5m
      annotations:
        summary: "P95 database latency exceeds 500ms"
```

---

## 10. COMPLIANCE & DATA PROTECTION

### GDPR Compliance

```javascript
class GDPRCompliance {
  // Right to deletion
  async deleteUserData(userId) {
    await db.delete('users', { id: userId });
    await db.delete('user_subscriptions', { user_id: userId });
    await db.delete('api_logs', { user_id: userId });
    await db.delete('audit_logs', { user_id: userId });
  }

  // Data portability
  async exportUserData(userId) {
    const user = await db.get('users', userId);
    const subscriptions = await db.query('SELECT * FROM user_subscriptions WHERE user_id = ?', [userId]);
    const apiLogs = await db.query('SELECT * FROM api_logs WHERE user_id = ?', [userId]);
    
    return {
      user,
      subscriptions,
      apiLogs,
      exportedAt: new Date().toISOString()
    };
  }

  // Consent management
  async trackConsent(userId, type, granted) {
    await db.insert('consent_logs', {
      user_id: userId,
      consent_type: type,
      granted,
      timestamp: new Date(),
      ip_address: req.ip,
      user_agent: req.headers['user-agent']
    });
  }
}
```

### Data Encryption

```javascript
const crypto = require('crypto');

class EncryptionService {
  encrypt(text, secret = process.env.ENCRYPTION_KEY) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(secret), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  decrypt(text, secret = process.env.ENCRYPTION_KEY) {
    const parts = text.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(secret), iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
```

---

## Quick Start: Environment Setup

```bash
# Clone repository
git clone https://github.com/your-org/daily-regulatory.git
cd daily-regulatory

# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your configuration

# Run database migrations
npm run migrate

# Start development server
npm run dev

# Run tests
npm test

# Build for production
npm run build

# Deploy to Kubernetes
kubectl apply -f k8s/
```

---

## Support & Documentation

- **API Docs**: https://api.dailyregulatory.com/docs
- **Status Page**: https://status.dailyregulatory.com
- **Support Portal**: https://support.dailyregulatory.com
- **Security Reporting**: security@dailyregulatory.com
