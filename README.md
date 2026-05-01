# @donotdev/functions

Unified functions package supporting both Firebase Cloud Functions and Vercel Functions with clean, simple architecture. Each function is one file, with shared algorithms only for complex business logic.

## 📦 Package vs Templates

**IMPORTANT:** This directory contains the published `@donotdev/functions` NPM package, not templates.

| Location                              | What It Is                | Purpose                        |
| ------------------------------------- | ------------------------- | ------------------------------ |
| `/functions/` (this directory)        | Published NPM package     | Framework code you import      |
| `/packages/cli/templates/functions-*` | CLI scaffolding templates | Example usage (.example files) |

**How they relate:**

```
@donotdev/functions (published package)
    ↓ imported by
Your App Functions (scaffolded by CLI)
    ↓ uses your config
Framework Implementation + Your Business Logic
```

**Example:**

```typescript
// apps/your-app/functions/src/billing/createCheckoutSession.ts
import { createCheckoutSession as generic } from '@donotdev/functions/firebase';
import { stripeBackConfig } from '../config/stripeBackConfig';

// Your app's function = framework + your config
export const createCheckoutSession = generic(stripeBackConfig);
```

See [Functions Package Architecture](../docs/architecture/FUNCTIONS_PACKAGE.md) for detailed explanation.

## 🎯 Design Principles

- **1 File Per Function**: Simple, maintainable functions
- **Direct Implementation**: Easy functions coded directly in Firebase/Vercel files
- **Shared Algorithms**: Complex functions use shared business logic
- **One Utils Package**: Centralized utilities with internal/external separation
- **Framework Integration**: Functions can be scaffolded into consuming apps

## 📁 Package Structure

```
functions/src/
├── shared/
│   ├── utils/               # ONE utils package
│   │   ├── internal/        # Functions-only utilities
│   │   │   ├── firebase.ts  # Firebase Admin initialization
│   │   │   ├── errors.ts    # handleError, DoNotDevError
│   │   │   ├── auth.ts      # assertAuthenticated, assertAdmin
│   │   │   └── validation.ts # validateStripeEnvironment
│   │   ├── external/        # Framework utilities
│   │   │   ├── subscription.ts # getTierFromPriceId, etc.
│   │   │   ├── metadata.ts  # createMetadata, updateMetadata
│   │   │   └── date.ts      # toISOString
│   │   └── index.ts         # Export everything
│   ├── billing/             # Shared billing algorithms
│   │   ├── createCheckout.ts # createCheckoutAlgorithm()
│   │   ├── processPayment.ts # processPaymentAlgorithm()
│   │   └── webhook.ts       # webhookAlgorithm()
│   └── oauth/               # Shared OAuth algorithms
│       ├── exchangeToken.ts # exchangeTokenAlgorithm()
│       └── grantAccess.ts   # grantAccessAlgorithm()
├── firebase/                # Firebase Cloud Functions
│   ├── auth/                # Simple auth functions
│   │   ├── getUserClaims.ts # Direct Firebase call
│   │   ├── setUserClaims.ts # Direct Firebase call
│   │   └── removeUserClaims.ts # Direct Firebase call
│   ├── billing/             # Complex billing functions
│   │   ├── createCheckout.ts # Uses shared/billing/createCheckout
│   │   ├── processPayment.ts # Uses shared/billing/processPayment
│   │   └── webhook.ts       # Uses shared/billing/webhook
│   ├── crud/                # Simple CRUD functions
│   │   ├── create.ts        # Direct Firestore call
│   │   ├── get.ts           # Direct Firestore call
│   │   └── list.ts          # Direct Firestore call
│   └── config/
│       └── constants.ts     # Firebase function configs
└── vercel/api/              # Vercel API Routes
    ├── auth/                # Simple auth endpoints
    │   ├── getUserClaims.ts # Direct Firebase call
    │   ├── setUserClaims.ts # Direct Firebase call
    │   └── removeUserClaims.ts # Direct Firebase call
    ├── billing/             # Complex billing endpoints
    │   ├── createCheckout.ts # Uses shared/billing/createCheckout
    │   ├── processPayment.ts # Uses shared/billing/processPayment
    │   └── webhook.ts       # Uses shared/billing/webhook
    ├── crud/                # Simple CRUD endpoints
    │   ├── create.ts        # Direct Firestore call
    │   ├── get.ts           # Direct Firestore call
    │   └── list.ts          # Direct Firestore call
    └── config/
        └── constants.ts     # Vercel function configs
```

## 🏗️ Function Architecture

### Simple Functions (Direct Implementation)

**Example: Get User Claims**

```typescript
// functions/src/firebase/auth/getUserClaims.ts
import { onCall } from 'firebase-functions/v2/https';
import { getAuth } from 'firebase-admin/auth';
import { handleError } from '../../shared/utils';
import { AUTH_CONFIG } from '../config/constants';

export const getUserClaims = onCall(AUTH_CONFIG, async (request) => {
  try {
    const { userId } = request.data;
    const user = await getAuth().getUser(userId);
    return user.customClaims || {};
  } catch (error) {
    throw handleError(error);
  }
});
```

### Complex Functions (Shared Algorithms)

**Example: Create Checkout Session**

```typescript
// functions/src/firebase/billing/createCheckout.ts
import { onCall } from 'firebase-functions/v2/https';
import { handleError } from '../../shared/utils';
import { createCheckoutAlgorithm } from '../../shared/billing/createCheckout';
import { STRIPE_CONFIG } from '../config/constants';

export const createCheckout = onCall(STRIPE_CONFIG, async (request) => {
  try {
    return await createCheckoutAlgorithm(request.data, firebaseProvider);
  } catch (error) {
    throw handleError(error);
  }
});
```

**Shared Algorithm:**

```typescript
// functions/src/shared/billing/createCheckout.ts
export async function createCheckoutAlgorithm(request, provider) {
  // Complex billing logic that works with both Firebase and Vercel
  // Uses provider interface for platform-specific operations
}
```

## 🎯 Framework Integration

### Scaffolding Functions into Apps

When creating a new app, the framework can scaffold functions based on the chosen platform:

```bash
# Create app with Firebase functions
bun create-dndev-app my-app --platform firebase

# Create app with Vercel functions
bun create-dndev-app my-app --platform vercel
```

**Generated Structure:**

```
my-app/
├── functions/                 # Scaffolded from @donotdev/functions
│   ├── src/
│   │   ├── firebase/         # OR vercel/api/ based on choice
│   │   │   ├── auth/
│   │   │   │   ├── getUserClaims.ts
│   │   │   │   └── setUserClaims.ts
│   │   │   ├── billing/
│   │   │   │   ├── createCheckout.ts
│   │   │   │   └── webhook.ts
│   │   │   └── crud/
│   │   │       ├── create.ts
│   │   │       └── get.ts
│   │   └── shared/           # Copied shared utilities
│   │       ├── utils/
│   │       ├── billing/
│   │       └── oauth/
│   └── package.json
└── src/
    └── components/
        └── CheckoutButton.tsx # Uses scaffolded functions
```

### Function Customization

Developers can:

- **Use as-is**: Functions work out of the box
- **Customize**: Modify scaffolded functions for specific needs
- **Remove**: Delete unused functions
- **Replace**: Implement custom business logic

**Example Customization:**

```typescript
// my-app/functions/src/firebase/auth/getUserClaims.ts
// Developer can modify this scaffolded function
export const getUserClaims = onCall(AUTH_CONFIG, async (request) => {
  try {
    const { userId } = request.data;
    const user = await getAuth().getUser(userId);

    // Custom business logic
    const customClaims = user.customClaims || {};
    const filteredClaims = filterSensitiveClaims(customClaims);

    return filteredClaims;
  } catch (error) {
    throw handleError(error);
  }
});
```

## 🚀 Quick Start

### 1. Framework Development

```bash
# Install dependencies
bun install

# Build all platforms
bun run build
```

### 2. Environment Variables

**Firebase Functions:**

```bash
STRIPE_SECRET_KEY=<stripe_secret_key>
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_API_VERSION=2025-08-27.basil  # REQUIRED - No fallback
```

**Vercel Functions:**

```bash
STRIPE_SECRET_KEY=<stripe_secret_key>
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_API_VERSION=2025-08-27.basil  # REQUIRED - No fallback
FIREBASE_ADMIN_PRIVATE_KEY="<firebase_private_key>"
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-...@your-project.iam.gserviceaccount.com
```

### 3. Development

```bash
# Firebase development
bun run dev:firebase

# Vercel development
bun run dev:vercel
```

### 4. Deployment

```bash
# Deploy to Firebase
bun run deploy:firebase

# Deploy to Vercel
bun run deploy:vercel
```

## 🔐 Authentication Functions

### Firebase Cloud Functions

#### Create Checkout Session

```typescript
// Called from client with Firebase Auth token
// Direct Stripe integration - no Firebase Functions needed
import { loadStripe } from '@stripe/stripe-js';

const stripe = await loadStripe(process.env.VITE_STRIPE_PUBLISHABLE_KEY);
const { error } = await stripe.redirectToCheckout({
  priceId: 'price_pro_monthly',
  userId: user.uid,
  userEmail: user.email,
  metadata: { plan: 'pro' },
  allowPromotionCodes: true,
});

// Redirect to Stripe Checkout
window.location.href = result.data.sessionUrl;
```

#### Stripe Webhook

- **URL**: `https://your-project.cloudfunctions.net/stripeWebhook`
- **Events**: `customer.subscription.*`, `invoice.payment.*`, `checkout.session.completed`
- **Purpose**: Updates Firebase custom claims with subscription data

#### Refresh Subscription Status

```typescript
const refreshSubscription = httpsCallable(
  functions,
  'refreshSubscriptionStatus'
);

const result = await refreshSubscription({
  userId: user.uid,
});

console.log(result.data.subscription); // Updated subscription data
```

### Vercel API Routes

#### Create Checkout Session

```typescript
// POST /api/auth/create-checkout-session
const response = await fetch('/api/auth/create-checkout-session', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${await user.getIdToken()}`,
  },
  body: JSON.stringify({
    priceId: 'price_pro_monthly',
    userId: user.uid,
    userEmail: user.email,
    metadata: { plan: 'pro' },
  }),
});

const { sessionUrl } = await response.json();
window.location.href = sessionUrl;
```

#### Stripe Webhook

- **URL**: `https://your-domain.vercel.app/api/auth/stripe-webhook`
- **Events**: Same as Firebase version
- **Purpose**: Updates Firebase custom claims with subscription data

#### Refresh Subscription Status

```typescript
// POST /api/auth/refresh-subscription
const response = await fetch('/api/auth/refresh-subscription', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${await user.getIdToken()}`,
  },
  body: JSON.stringify({
    userId: user.uid,
  }),
});

const { subscription } = await response.json();
```

## 🎯 Subscription Management

### How It Works

1. **Purchase Flow**:
   - User clicks subscribe button
   - Client calls Stripe directly
   - User completes payment on Stripe
   - Stripe webhook updates Firebase custom claims

2. **Subscription Data Storage**:

   ```typescript
   // Stored in Firebase Auth custom claims
   {
     subscription: {
       tier: 'pro' | 'ai' | 'free',
       subscriptionId: 'sub_1234...',
       customerId: 'cus_1234...',
       status: 'active' | 'canceled' | ...,
       subscriptionEnd: 1640995200000, // Unix timestamp
       cancelAtPeriodEnd: false,
       updatedAt: 1640995200000,
     }
   }
   ```

3. **Client-Side Access**:

   ```typescript
   import { useSubscription } from '@donotdev/auth';

   const { subscription, loading } = useSubscription();

   if (subscription?.tier === 'pro') {
     // Show pro features
   }
   ```

### Tier Mapping

Configure your Stripe price IDs in `src/shared/utils/index.ts`:

```typescript
const tierMapping: Record<string, SubscriptionTier> = {
  price_pro_monthly: 'pro',
  price_pro_yearly: 'pro',
  price_ai_monthly: 'ai',
  price_ai_yearly: 'ai',
};
```

## 🔧 Configuration

### Firebase Functions

1. **Set Environment Variables**:

   ```bash
   firebase functions:config:set stripe.secret_key="<stripe_secret_key>"
   firebase functions:config:set stripe.webhook_secret="whsec_..."
   ```

2. **Deploy**:

   ```bash
   bun run deploy:firebase
   ```

3. **Configure Stripe Webhook**:
   - URL: `https://your-project.cloudfunctions.net/stripeWebhook`
   - Events: Select all `customer.subscription.*` and `invoice.payment.*` events

### Vercel Functions

1. **Set Environment Variables** in Vercel dashboard:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `FIREBASE_ADMIN_PRIVATE_KEY`
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_CLIENT_EMAIL`

2. **Deploy**:

   ```bash
   bun run deploy:vercel
   ```

3. **Configure Stripe Webhook**:
   - URL: `https://your-domain.vercel.app/api/auth/stripe-webhook`
   - Events: Same as Firebase version

## 🧪 Testing

```bash
# Run all tests
bun test

# Test specific platform
bun run test:firebase
bun run test:vercel

# Type checking
bun run typecheck
```

### Testing Webhooks Locally

#### Firebase Emulator

```bash
# Terminal 1: Start emulator
bun run dev:firebase

# Terminal 2: Forward webhooks
stripe listen --forward-to localhost:5001/your-project/europe-west1/stripeWebhook
```

#### Vercel

```bash
# Terminal 1: Start Vercel dev
bun run dev:vercel

# Terminal 2: Forward webhooks
stripe listen --forward-to localhost:3000/api/auth/stripe-webhook
```

## 📝 Usage Examples

### Client-Side Integration

#### SPA (Firebase Functions)

```typescript
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useAuth } from '@donotdev/auth';

function CheckoutButton({ priceId }: { priceId: string }) {
  const { user } = useAuth();
  const functions = getFunctions();

  const handleCheckout = async () => {
    // Direct Stripe integration
    const stripe = await loadStripe(process.env.VITE_STRIPE_PUBLISHABLE_KEY);
    const { error } = await stripe.redirectToCheckout({
      priceId,
      userId: user.uid,
      userEmail: user.email,
    });

    window.location.href = result.data.sessionUrl;
  };

  return (
    <button onClick={handleCheckout}>
      Subscribe
    </button>
  );
}
```

#### Next.js (Vercel Functions)

```typescript
import { useAuth } from '@donotdev/auth';

function CheckoutButton({ priceId }: { priceId: string }) {
  const { user } = useAuth();

  const handleCheckout = async () => {
    const response = await fetch('/api/auth/create-checkout-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${await user.getIdToken()}`,
      },
      body: JSON.stringify({
        priceId,
        userId: user.uid,
        userEmail: user.email,
      }),
    });

    const { sessionUrl } = await response.json();
    window.location.href = sessionUrl;
  };

  return (
    <button onClick={handleCheckout}>
      Subscribe
    </button>
  );
}
```

## 🚨 Security Notes

### Firebase Functions

- Uses Firebase Admin SDK for token verification
- Automatic user authentication through callable functions
- Environment variables managed through Firebase config

### Vercel Functions

- Uses Firebase Admin SDK with service account credentials
- Proper ID token verification using `auth.verifyIdToken()`
- Service account credentials managed through Vercel environment variables
- All authentication is production-ready and secure

## 📚 API Reference

### Shared Types

- `SubscriptionTier`: `'free' | 'pro' | 'ai'`
- `SubscriptionStatus`: Stripe subscription statuses
- `SubscriptionClaims`: Firebase custom claims structure
- `CreateCheckoutSessionRequest`: Checkout session parameters
- `RefreshSubscriptionRequest`: Subscription refresh parameters

### Shared Utilities

- `updateUserSubscription()`: Updates Firebase custom claims
- `cancelUserSubscription()`: Resets user to free tier
- `getUserSubscription()`: Gets user's current subscription
- `getTierFromPriceId()`: Maps Stripe price to tier
- `assertAuthenticated()`: Validates user authentication
- `DoNotDevError`: Custom error class

## 🎯 Best Practices

1. **Function Design**:
   - Keep simple functions simple (direct implementation)
   - Use shared algorithms only for complex business logic
   - One file per function for maintainability

2. **Utils Organization**:
   - Internal utils: Functions-only utilities
   - External utils: Framework-wide utilities
   - Clear separation of concerns

3. **Error Handling**:
   - Use `handleError()` for consistent error responses
   - Use `DoNotDevError` for custom error types

4. **Environment Variables**:
   - Always use environment variables for secrets
   - Platform-specific configuration in constants files

5. **Security**:
   - Verify Firebase tokens properly in production
   - Use webhook secrets for security
   - Handle authentication consistently

6. **Testing**:
   - Test both platforms with the same business logic
   - Test shared algorithms independently

7. **Scaffolding**:
   - Functions should work out of the box when scaffolded
   - Allow easy customization and removal
   - Maintain clear interfaces for provider abstraction

## 🔧 Troubleshooting

### Common Issues

1. **"Missing Firebase Admin SDK"**:
   - Ensure Firebase is initialized in shared utilities
   - Check environment variables

2. **"Webhook signature verification failed"**:
   - Verify webhook secret matches Stripe dashboard
   - Check raw body handling

3. **"Permission denied"**:
   - Verify Firebase Auth token is valid
   - Check user has correct permissions

4. **"Subscription not updating"**:
   - Check webhook URL is correctly configured
   - Verify Firebase custom claims are being set

### Debug Mode

Enable debug logging:

```bash
# Firebase
export DEBUG=firebase-functions:*

# Vercel
export DEBUG=1
```

## 📄 License

All rights reserved. The DoNotDev framework and its premium features are the exclusive property of **Ambroise Park Consulting**.

© Ambroise Park Consulting – 2025
