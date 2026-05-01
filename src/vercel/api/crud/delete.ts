// packages/functions/src/vercel/api/crud/delete.ts

/**
 * @fileoverview Delete entity API handler
 * @description Vercel API route for deleting entities
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { GetEntityData } from '@donotdev/core/server';
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

import { handleError } from '../../../shared/errorHandling.js';
import { verifyAuthToken } from '../../../shared/utils/internal/auth.js';
import { validateCollectionName } from '../../../shared/utils.js';

import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // C1: verify JWT — previously only checked header presence.
    const uid = await verifyAuthToken(req);

    const { schema, id } = req.body as { schema: any; id: string };

    if (!schema || !id) {
      handleError(new Error('Missing schema or id'));
    }

    // W22: Validate collection name from client-supplied schema
    validateCollectionName(schema.metadata.collection);

    // Check if document exists
    const db = getFirebaseAdminFirestore();
    const doc = await db.collection(schema.metadata.collection).doc(id).get();

    if (!doc.exists) {
      handleError(new Error('Document not found'));
    }

    // Delete the document from Firestore
    await db.collection(schema.metadata.collection).doc(id).delete();

    return res.status(200).json({
      success: true,
      message: 'Document deleted successfully',
      id,
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
