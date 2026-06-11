# @donotdev/functions

## 0.1.43

### Patch Changes

- 59d99d4: Fix CORS preflight failure on Supabase CRUD dispatcher. The serve dispatcher now uses createEdgeFunction({ requireAuth: false }) for CORS handling, consistent with all other edge functions.
- a4c57d7: bugfixes and performance upgrades
- Updated dependencies [6b68659]
- Updated dependencies [98d641c]
- Updated dependencies [a4c57d7]
  - @donotdev/supabase@0.1.43
  - @donotdev/core@0.1.43
  - @donotdev/firebase@0.1.43
