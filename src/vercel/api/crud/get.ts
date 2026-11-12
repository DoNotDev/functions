// packages/functions/src/vercel/api/crud/get.ts

/**
 * @fileoverview Get entity API handler
 * @description Vercel API route for retrieving entities
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { HIDDEN_STATUSES } from '@donotdev/core/server';
import type { GetEntityData } from '@donotdev/core/server';

import { DoNotDevError, handleError } from '../../../shared/errorHandling.js';
import { transformFirestoreData } from '../../../shared/firebase.js';
import { filterVisibleFields } from '../../../shared/schema.js';
import { verifyAuthToken } from '../../../shared/utils/internal/auth.js';
import { validateCollectionName } from '../../../shared/utils.js';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // C1: verify JWT — previously only checked header presence.
    const uid = await verifyAuthToken(req);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: the client supplies the validation schema (known limitation W22); typing needs a server-side entity registry
    const { schema, id } = req.query as unknown as GetEntityData<any>;

    // G71: Validate query params are strings (Next.js can pass string[] for repeated params)
    if (typeof id !== 'string' || !id) {
      handleError(new Error('Missing or invalid id parameter'));
    }

    if (!schema) {
      handleError(new Error('Missing schema'));
    }

    // W22: Validate collection name from client-supplied schema
    validateCollectionName(schema.metadata.collection);

    // Get the document from Firestore
    const { getFirebaseAdminFirestore } =
      await import('@donotdev/firebase/server');
    const db = getFirebaseAdminFirestore();
    const doc = await db
      .collection(schema.metadata.collection)
      .doc(id as string)
      .get();

    if (!doc.exists) {
      handleError(new Error('Document not found'));
    }

    // Hide drafts/deleted (Vercel routes treat all requests as non-admin)
    const docData = doc.data();
    if ((HIDDEN_STATUSES as readonly string[]).includes(docData?.status)) {
      handleError(new Error('Document not found'));
    }

    // Transform the document data
    const documentData = transformFirestoreData({
      id: doc.id,
      ...docData,
    });

    // Filter visible fields based on schema
    const filteredData = filterVisibleFields(documentData, schema, false);

    return res.status(200).json(filteredData);
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
