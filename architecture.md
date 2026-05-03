# Sport Bar Assistant — System Architecture

## Overview

This document describes the layered architecture of the Sport Bar Personal Assistant.  
**v1** ships with a Telegram bot client. The backend is designed so any future channel (web, mobile) plugs in via the channel adapter interface with zero changes to domain logic.

---

## Layers

| Layer | Responsibility |
|---|---|
| **Clients** | User-facing channels — Telegram bot (v1), Web / Mobile (future) |
| **Gateway** | NestJS API Gateway — routing, auth, rate limiting, channel adapter |
| **Services** | Domain logic — games schedule, promo generation, scheduled jobs |
| **Queue** | BullMQ workers — async AI generation tasks with retry logic |
| **Integrations** | External APIs — Sports data, Claude AI text, fal.ai image generation |
| **Infra** | PostgreSQL + Prisma ORM, Redis + BullMQ, Cloudinary, Docker |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                          CLIENTS                                │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │   Telegram Bot   │  │  Web Frontend *  │  │  Mobile *    │  │
│  │  (v1 · active)   │  │  React / Next.js │  │  future      │  │
│  └────────┬─────────┘  └────────┬─────────┘  └──────┬───────┘  │
└───────────┼────────────────────┼───────────────────┼───────────┘
            │                    │                   │
            ▼                    ▼                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                         GATEWAY                                 │
│                                                                 │
│          ┌──────────────────────────────────────┐               │
│          │         NestJS API Gateway           │               │
│          │  REST + WebSocket  ·  Auth           │               │
│          │  Rate limiting  ·  Channel adapter   │               │
│          └──────────────────┬───────────────────┘               │
└─────────────────────────────┼───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        DOMAIN SERVICES                          │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │  Games Service   │  │  Promo Service   │  │  Scheduler   │  │
│  │  Today / week    │  │  Enqueues AI     │  │  Cron jobs   │  │
│  │  schedule        │  │  gen tasks       │  │  auto-posts  │  │
│  └────────┬─────────┘  └────────┬─────────┘  └──────┬───────┘  │
└───────────┼────────────────────┼───────────────────┼───────────┘
            │                    │                   │
            │                    ▼                   │
            │   ┌────────────────────────────────┐   │
            │   │         BULLMQ QUEUE           │   │
            │   │  AI text jobs · AI image jobs  │   │
            │   │  Retry logic · failure alerts  │   │
            │   └────────────────┬───────────────┘   │
            │                    │                   │
            ▼                    ▼                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                       INTEGRATIONS                              │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │   Sports API     │  │   AI Text        │  │  AI Image    │  │
│  │  API-Football    │  │  Anthropic       │  │  fal.ai      │  │
│  │  / SportRadar    │  │  Claude API      │  │  FLUX model  │  │
│  └────────┬─────────┘  └────────┬─────────┘  └──────┬───────┘  │
└───────────┼────────────────────┼───────────────────┼───────────┘
            │                    │                   │
            ▼                    ▼                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                       INFRASTRUCTURE                            │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │   PostgreSQL     │  │  Redis + BullMQ  │  │  Cloudinary  │  │
│  │  Prisma ORM      │  │  Cache · queue   │  │  Images ·    │  │
│  │  Data schema     │  │  Job workers     │  │  transforms  │  │
│  └──────────────────┘  └──────────────────┘  └──────────────┘  │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │          Docker Compose (dev)  →  Railway (prod)          │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘

  * Dashed = planned future channel
```

---

## Tech Stack Summary

### Backend
- **Runtime:** Node.js + TypeScript
- **Framework:** NestJS
- **Database:** PostgreSQL via **Prisma ORM** — type-safe schema, migrations, and query builder
- **Cache / Queue:** Redis + **BullMQ** — job queuing, retry logic, and worker concurrency for long-running AI tasks

### Clients
- **v1:** Telegram bot via `telegraf` library
- **Future:** REST/WebSocket — any frontend plugs into the channel adapter

### AI APIs
- **Promo copy:** Anthropic Claude API — structured creative output (caption, hashtags, CTA)
- **Poster images:** fal.ai with FLUX model — high-quality graphic/promotional imagery

### Media Storage
- **Cloudinary** — S3-compatible storage with built-in dynamic image transformation, resizing, and CDN delivery for generated poster images

### Sports Data
- **v1:** API-Football (api-sports.io) — soccer, basketball, American football; generous free tier
- **Future:** SportRadar for enterprise-grade coverage

### Deployment
- **Dev:** Docker Compose (all services local)
- **Prod:** Railway — app + PostgreSQL + Redis all in one project, git-push deploys

---

## Queue Architecture

AI generation tasks (promo copy and poster images) are long-running and failure-prone. Rather than calling the AI APIs synchronously inside a request cycle, the Promo Service enqueues a job into BullMQ. A dedicated worker process picks it up, calls the APIs, uploads the result to Cloudinary, and delivers the output back to the user via the channel adapter.

This gives us:

- **Reliability** — failed jobs are retried automatically with configurable backoff
- **Decoupling** — the gateway returns immediately; the user gets a response when the asset is ready
- **Visibility** — job state (pending, active, completed, failed) is queryable via BullMQ's dashboard

```typescript
// Example job payload
export interface PromoJobPayload {
  barId: string;
  gameId: string;
  channel: 'telegram' | 'web';
  userId: string;
  type: 'copy' | 'image' | 'full';
}
```

---

## Scalability Design Principle

The **Channel Adapter Interface** in the gateway is the key to frontend flexibility.  
Telegram is one implementation. A web frontend or mobile app is another — domain services never know or care which channel they're talking to.

```typescript
// Example interface (NestJS)
export interface ChannelAdapter {
  sendMessage(userId: string, text: string): Promise<void>;
  sendImage(userId: string, imageUrl: string, caption?: string): Promise<void>;
  onMessage(handler: MessageHandler): void;
}
```

---

## Sprint Plan

| Sprint | Focus |
|---|---|
| **1** | NestJS skeleton · Telegram connected · channel adapter interface · **PostgreSQL + Prisma setup · data schema** · health check |
| **2** | Sports API integration · "games today" and "games this week" commands · schedule persistence in DB |
| **3** | Claude integration for promo copy · fal.ai for poster images · **BullMQ workers for async AI jobs** · Cloudinary upload |
| **4** | Scheduler (cron auto-posts) · Redis caching layer · monitoring + retry dashboards |
