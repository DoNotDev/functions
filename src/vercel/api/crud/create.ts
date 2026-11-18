// packages/functions/src/vercel/api/crud/create.ts

/**
 * @fileoverview Create entity API handler
 * @description Vercel API route for creating entities.
 *
 * The request carries one schema (W22): the caller sends the one
 * `prepareCreate` (core/schemas crud/create) picks (`draft` or `create`). A create
 * without status gets `DEFAULT_STATUS_VALUE`; the parse output is written, never the
 * raw payload.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { prepareCreate } from '@donotdev/core/server';
import type { CreateEntityData } from '@donotdev/core/server';

import { DoNotDevError, handleError } from '../../../shared/errorHandling.js';
import {
  prepareForFirestore,
  transformFirestoreData,
} from '../../../shared/firebase.js';
import { createMetadata } from '../../../shared/metadata.js';
import { verifyAuthToken } from '../../../shared/utils/internal/auth.js';
import { writtenOf } from '../../../shared/crud/written.js';
import { validateCollectionName } from '../../../shared/utils.js';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // C1: verify JWT — previously only checked header presence.
    const uid = await verifyAuthToken(req);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: the client supplies the validation schema (known limitation W22); typing needs a server-side entity registry
    const { schema, payload } = req.body as CreateEntityData<any>;

    if (!schema || !payload) {
      handleError(new Error('Missing schema or payload'));
    }

    // W22: Validate collection name from client-supplied schema
    validateCollectionName(schema.metadata.collection);

    // CRUD create rules (core/schemas crud/create), resulting status included.
    // W22: the client supplies one schema, used for drafts and creates alike.
    const written = writtenOf(
      prepareCreate({ create: schema, draft: schema }, payload),
      schema.metadata.collection,
      'create'
    );

    // Prepare the document for Firestore and add metadata
    const documentData = {
      ...prepareForFirestore(written),
      ...createMetadata(uid),
    };

    // Save the document to Firestore
    const { getFirebaseAdminFirestore } =
      await import('@donotdev/firebase/server');
    const db = getFirebaseAdminFirestore();
    const docRef = await db
      .collection(schema.metadata.collection)
      .add(documentData);

    // Retrieve the created document
    const doc = await docRef.get();

    // Transform the document data back to the application format
    const result = transformFirestoreData({
      id: doc.id,
      ...doc.data(),
    });

    return res.status(200).json(result);
  } catch (error) {
    try {
      handleError(error);
    } catch (handledError) {
      // handleError always throws DoNotDevError; narrow for typed access
      if (!(handledError instanceof DoNotDevError)) throw handledError;
      const status = handledError.code === 'invalid-argument' ? 400 : 500;
      return res
        .status(status)
        .json({ error: handledError.message, code: handledError.code });
    }
  }
}
