# Nave — Architecture Overview

Nave is a Catholic culture heat map that helps Catholics find community — parishes, schools, missionaries, retreats, businesses, vocations, pilgrimages, and campus ministries. It runs as an iOS app and a website, sharing the same Firebase backend.

## Tech Stack

### iOS App (`/Users/oliverolsen/Documents/NaveiOSAppPrime/TheNave/`)
- **Language**: Swift / SwiftUI
- **Min target**: iOS 17+
- **Architecture**: Service-oriented with tiered initialization (Tier 1: critical map/auth, Tier 2: tab-specific, Tier 3: background)
- **Navigation**: Custom tab bar with two modes:
  - **Laity Mode**: Explore (Map) | Engage | Ask (Gabriel AI) | Home
  - **Business Mode**: KPI | Laurels | Keys | Home
- **Dependencies** (SPM):
  - Firebase iOS SDK 11.6.0 (Auth, Firestore)
  - RevenueCat 5.0.0 (subscriptions)
  - Google Sign-In 8.0.0
- **Entry point**: `TheNave/App/TheNaveApp.swift` → `ContentView.swift`

### Website (`/Users/oliverolsen/Documents/navewebsitestartup/`)
- **Stack**: Vanilla HTML / CSS / JavaScript (no framework)
- **Firebase JS SDK**: 10.7.1 (via CDN ES modules)
- **Deployment**: Vercel (`vercel.json` with `cleanUrls: true`)
- **Serverless functions**: `/api/ask-gabe.js`, `/api/gabriel.js` (Node.js on Vercel)
- **Pages**: `index.html`, `map.html`, `ask-gabe.html`, `engage.html`, `join.html`, `about.html`
- **JS modules**: `firebase-config.js`, `app.js`, `engage.js`, `join.js`, `gabe-service.js`
- **Single CSS file**: `styles.css` (~2800 lines, CSS variables for dark theme)

### Backend (Firebase — project: `navefirebase`)
- **Auth**: Google Sign-In, Apple Sign-In, Email Link, Phone SMS
- **Database**: Firestore
- **Storage**: Firebase Storage (org logos at `org-logos/`)
- **No Cloud Functions** — serverless logic is on Vercel

## Firestore Collections

### Map entities (8 key types)
| Collection | Key type | iOS model |
|---|---|---|
| `Churches` | Parish | `parish` |
| `businesses` | Business | `business` |
| `schools` | School | `school` |
| `pilgrimageSites` | Pilgrimage | `pilgrimage` |
| `retreats` | Retreat | `retreat` |
| `vocations` | Vocation | `vocation` |
| `missionaries` | Missionary | `missionary` |
| `bibleStudies` | Campus Ministry | `bibleStudy` |

All entities share: `id`, `name`, `latitude`, `longitude`, `address`, `description`, `isActive`, `isVerified`, `isPremium`, `createdAt`, `updatedAt`, `source`, `country`.

### Engage (professional networking)
- `organizations/` — org profile (name, description, accentColorHex, backgroundColorHex, logoURL, logoAssetName, iconName, type, features, websiteURL, memberCount)
- `organizations/{orgId}/channels/` — channel list
- `organizations/{orgId}/channels/{channelId}/messages/` — channel messages
- `organizations/{orgId}/forumPosts/` — forum posts
- `organizations/{orgId}/forumPosts/{postId}/replies/` — forum replies
- `organizationMembers/` — membership (userId, organizationId, role)
- `invitations/` — org invitations (userId, organizationId, status)
- `organizationInterests/` — interest expressions
- `managedOrganizations/` — cloud-managed org configs

### Messaging
- `messages_threads/` — DM threads (participantIds, participantNames, lastMessage, lastMessageAt)
- `messages_threads/{threadId}/messages/` — individual messages

### User data
- `users/{userId}/submissions/` — key submission records
- `waitlist` — email waitlist signups

### Seeded organizations
SENT Ventures, Nave, CLI, FOCUS, ICLE, NASPA — seeded by `EngageSeedService.swift` on iOS. Logos stored in Firebase Storage with real HTTPS URLs in `logoURL`.

## Feature 1: Map

### iOS
- **Framework**: Native MapKit (`MKMapView`)
- **View**: `Features/Map/MapboxClusteredMapView.swift` (name is legacy — actually uses MapKit)
- **Clustering**: Custom annotation clustering with dark mode support
- **Data loading**: Reads all 8 entity collections from Firestore, renders as colored dots
- **Detail views**: Tapping a dot opens a full detail view per type (e.g., `PrimeParishUnlockedView`, `BusinessDetailViewPrime`, etc.)
- **Owner edit mode**: Pencil icon → edit mode → "+" button to add custom sections (photos, events, hours, staff, etc.)

### Website
- **Framework**: Leaflet 1.9.4 with leaflet.markercluster 1.5.3
- **Page**: `map.html`
- **Tiles**: Dark theme tile layer
- **Features**: Legend/filter panel for toggling key types, custom colored markers, zoom controls
- **Data**: Fetches all entities from Firestore, renders as clustered markers

## Feature 2: Ask (Gabriel AI)

### iOS
- **Service**: `Core/Services/UnifiedIntelligenciaService.swift`
- **API**: OpenAI (`https://api.openai.com/v1/chat/completions`)
- **Architecture**: Unified RAG — fetches ranked context from all Firebase entity types, builds semantic search with embeddings + TF-IDF, sends to OpenAI with domain-specific system prompts
- **Conversation**: Maintains chat history in memory
- **UI**: Chat interface with message bubbles, tappable recommendation cards

### Website
- **Pages**: `ask-gabe.html` + `gabe-service.js`
- **Backend**: Vercel serverless function at `/api/ask-gabe.js`
- **API**: OpenAI (via `process.env.OPENAI_API_KEY`)
- **Architecture**: Orchestrator + 8 Expert system:
  1. Orchestrator classifies user query via LLM
  2. Fetches Firebase data for activated experts (parallel)
  3. Domain-specific prompts injected into focused LLM call
  4. Parses `[RECOMMEND:]` tags → tappable suggestion cards
- **Experts**: 8 domains matching the 8 key types
- **Safety**: Prompt injection firewall, rate limiting (20 req/min), content validation

## Feature 3: Engage

### iOS
- **Views**: `Features/Engage/` — `EngageHomeView`, `OrganizationsListView`, `OrganizationDetailView`, `ChannelsView`, `DiscoveryView`, etc.
- **Seed service**: `Core/Services/EngageSeedService.swift` seeds 6 default organizations
- **Features**: Organization list, channels (real-time chat), forums, resources, DM threads, invitations, discovery (suggested orgs)
- **Real-time**: Firestore `onSnapshot` listeners for messages

### Website
- **Page**: `engage.html` + `engage.js`
- **Auth gate**: Google/Apple/Email sign-in (same pattern as join flow)
- **Layout**: Sidebar (Home / Inbox / Network / Discovery) + content area
- **Features**:
  - **Home**: Dashboard with preview cards (inbox, network, discovery)
  - **Inbox**: Message threads with filter tabs, DM chat modal with real-time messages
  - **Network**: Organization list with search, org detail modal (Channels / Forums / Resources tabs), channel chat modal
  - **Discovery**: Pending invitations (accept/decline), suggested orgs (express interest)
- **Org logos**: Loaded from `logoURL` (Firebase Storage HTTPS URLs), fallback to colored initials
- **Accent**: `#4C8BF5` blue for Engage-specific elements (vs `#d4af37` gold for rest of site)

## CSS Design System

Dark theme with CSS variables defined in `styles.css`:
- `--color-bg: #0a0a0a` — page background
- `--color-bg-alt: #111` — card/input backgrounds
- `--color-text: #f5f5f5` — primary text
- `--color-text-muted: #888` — secondary text
- `--color-border: #222` — borders
- `--color-accent: #d4af37` — gold accent (main site)
- `--color-accent-hover: #e6c84a` — gold hover
- Engage uses `#4C8BF5` blue accent separately
- Font: `Instrument Sans` (Google Fonts)
- Border radius: 12px (cards), 10px (avatars), 20px (pills)
- Mobile-first responsive with sidebar slide-in and full-screen modals

## Join / Submission Flow

- **Page**: `join.html` + `join.js`
- **Steps**: Sign In → Select Key Type → Subscribe → Submit Form → Success
- **Auth**: Google, Apple, Email Link, Phone SMS (Firebase Auth)
- **Per-type fields** match the iOS app submission forms:
  - Parish: Pastor Name, Email, Phone, Address/City/State/ZIP, + optional fields
  - Business/School/Pilgrimage/Retreat: Name, Location, Description, Founding Year
  - Missionary/Vocation: Name, Introduction (300 char), Parish Address, Website, + optional
  - Campus: Name, Introduction, Meeting Times, Parish Address, + optional
- **Geocoding**: Nominatim OpenStreetMap API for address → lat/long, with live green coordinate feedback on blur
- **Writes to**: Entity collection (e.g., `Churches`) + `users/{uid}/submissions/`
- **Post-submission disclaimer**: Shows what owners can add via "+" icon in the iOS app per key type

## Key File Paths

### iOS App
- `App/TheNaveApp.swift` — entry point, service initialization
- `App/ContentView.swift` — tab bar navigation
- `Features/Map/MapboxClusteredMapView.swift` — map view
- `Features/Engage/` — all Engage views
- `Core/Services/UnifiedIntelligenciaService.swift` — AI service
- `Core/Services/EngageSeedService.swift` — org seed data
- `Core/Models/Organization.swift` — org model
- `Resources/Assets.xcassets/` — image assets

### Website
- `firebase-config.js` — Firebase init (exports app, db, auth, googleProvider, appleProvider)
- `styles.css` — all styles (~2800 lines)
- `map.html` — map page (Leaflet)
- `ask-gabe.html` + `gabe-service.js` — AI chat frontend
- `api/ask-gabe.js` — AI chat backend (Vercel serverless)
- `engage.html` + `engage.js` — Engage feature
- `join.html` + `join.js` — submission flow
- `app.js` — shared utilities (waitlist, partner/contact modals)
