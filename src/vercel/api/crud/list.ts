// packages/functions/src/vercel/api/crud/list.ts

/**
 * @fileoverview List entities API handler
 * @description Vercel API route for listing entities
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { HIDDEN_STATUSES } from '@donotdev/core/server';
import type { ListEntityData } from '@donotdev/core/server';
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

import { handleError } from '../../../shared/errorHandling.js';
import { transformFirestoreData } from '../../../shared/index.js';
import { filterVisibleFields } from '../../../shared/index.js';
import { verifyAuthToken } from '../../../shared/utils/internal/auth.js';
import { validateCollectionName } from '../../../shared/utils.js';

import type { NextApiRequest, NextApiResponse } from 'next';

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

    const {
      schema,
      limit = 10,
      offset = 0,
    } = req.query as unknown as ListEntityData<any> & {
      limit?: string;
      offset?: string;
    };

    if (!schema) {
      handleError(new Error('Missing schema'));
    }

    // W22: Validate collection name from client-supplied schema
    validateCollectionName(schema.metadata.collection);

    // Get documents from Firestore
    const db = getFirebaseAdminFirestore();
    let query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> =
      db.collection(schema.metadata.collection);

    // Filter out hidden statuses (Vercel routes treat all requests as non-admin)
    query = query.where('status', 'not-in', [...HIDDEN_STATUSES]);

    // Clamp limit to prevent unbounded queries (max 1000, default 1000)
    const parsedLimit = Math.min(parseInt(limit as string) || 1000, 1000);
    const parsedOffset = parseInt(offset as string) || 0;

    // Apply limit and offset
    query = query.limit(parsedLimit);
    query = query.offset(parsedOffset);

    const snapshot = await query.get();

    // Transform the documents
    const documents = snapshot.docs.map((doc: any) => {
      const documentData = transformFirestoreData({
        id: doc.id,
        ...doc.data(),
      });
      return filterVisibleFields(documentData, schema, false);
    });

    return res.status(200).json({
      documents,
      total: snapshot.size,
      limit: parsedLimit,
      offset: parsedOffset,
    });
  } catch (error) {
    try {
      handleError(error);
    } catch (handledError: any) {
      const status = handledError.code === 'invalid-argument' ? 400 : 500;
      return res
        .status(status)
        .json({ error: handledError.message, code: handledError.code });
    }
  }
}
