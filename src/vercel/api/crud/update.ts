// packages/functions/src/vercel/api/crud/update.ts

/**
 * @fileoverview Update entity API handler
 * @description Vercel API route for updating entities
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { DEFAULT_STATUS_VALUE } from '@donotdev/core/server';
import type { UpdateEntityData } from '@donotdev/core/server';
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

import { handleError } from '../../../shared/errorHandling.js';
import {
  prepareForFirestore,
  transformFirestoreData,
} from '../../../shared/index.js';
import { updateMetadata } from '../../../shared/index.js';
import { verifyAuthToken } from '../../../shared/utils/internal/auth.js';
import {
  validateCollectionName,
  validateDocument,
} from '../../../shared/utils.js';

import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // C1: verify JWT — previously only checked header presence.
    const uid = await verifyAuthToken(req);

    const { schema, id, payload } = req.body as UpdateEntityData<any>;

    if (!schema || !id || !payload) {
      handleError(new Error('Missing schema, id, or payload'));
    }

    // W22: Validate collection name from client-supplied schema
    validateCollectionName(schema.metadata.collection);

    const db = getFirebaseAdminFirestore();

    // Get current document to merge with payload for status check
    const currentDoc = await db
      .collection(schema.metadata.collection)
      .doc(id)
      .get();

    if (!currentDoc.exists) {
      handleError(new Error('Document not found'));
    }

    // Merge current data with payload to determine resulting status
    const currentData = currentDoc.data() || {};
    const mergedData = { ...currentData, ...payload };
    const resultingStatus = mergedData.status ?? DEFAULT_STATUS_VALUE;
    const isDraft = resultingStatus === 'draft';

    // Validate the document against the schema
    // Skip validation for drafts - required fields can be incomplete
    if (!isDraft) {
      validateDocument(mergedData as Record<string, any>, schema);
    }

    // Prepare the document for Firestore and add metadata
    const documentData = {
      ...prepareForFirestore(payload),
      ...updateMetadata(uid),
    };

    // Update the document in Firestore
    await db
      .collection(schema.metadata.collection)
      .doc(id)
      .update(documentData);

    // Retrieve the updated document
    const doc = await db.collection(schema.metadata.collection).doc(id).get();

    if (!doc.exists) {
      handleError(new Error('Document not found'));
    }

    // Transform the document data back to the application format
    const result = transformFirestoreData({
      id: doc.id,
      ...doc.data(),
    });

    return res.status(200).json(result);
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
