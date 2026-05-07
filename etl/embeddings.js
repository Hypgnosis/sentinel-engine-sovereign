/**
 * SENTINEL ENGINE — Vertex AI Embedding Helper
 * ═══════════════════════════════════════════════════════════
 * Generates 768-dimensional vector embeddings using Vertex AI
 * text-embedding-004 via the @google/genai SDK.
 *
 * Design:
 *   - Batches up to 250 texts per API call (Vertex AI limit)
 *   - Returns arrays aligned 1:1 with input texts
 *   - Uses 'RETRIEVAL_DOCUMENT' task type for warehouse rows
 *   - Uses 'RETRIEVAL_QUERY' task type for user queries
 * ═══════════════════════════════════════════════════════════
 */

import { GoogleGenAI } from '@google/genai';

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || 'ha-sentinel-core-v21';
const GCP_REGION     = process.env.GCP_REGION     || 'us-central1';
const EMBEDDING_MODEL = 'text-embedding-004';
const MAX_BATCH_SIZE  = 250;
const EMBEDDING_DIM   = 768;

let ai = null;

/**
 * Initialize the GenAI SDK (singleton).
 */
function getClient() {
  if (!ai) {
    ai = new GoogleGenAI({
      vertexai: {
        project: GCP_PROJECT_ID,
        location: GCP_REGION,
      },
      project: GCP_PROJECT_ID,
      location: GCP_REGION,
    });
  }
  return ai;
}

/**
 * Generate embeddings for an array of text strings.
 *
 * @param {string[]} texts - Array of text strings to embed.
 * @param {'RETRIEVAL_DOCUMENT'|'RETRIEVAL_QUERY'} taskType - Embedding task type.
 * @returns {Promise<number[][]>} Array of 768-dimensional float arrays.
 */
export async function generateEmbeddings(texts, taskType = 'RETRIEVAL_DOCUMENT') {
  if (!texts || texts.length === 0) return [];

  const client = getClient();
  const allEmbeddings = [];

  // Process in batches to respect API limits
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);

    const response = await client.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: batch,
      config: {
        taskType,
        outputDimensionality: EMBEDDING_DIM,
      },
    });

    // Extract the float arrays from each embedding
    for (const embedding of response.embeddings) {
      allEmbeddings.push(embedding.values);
    }
  }

  // Validate dimensions
  for (let i = 0; i < allEmbeddings.length; i++) {
    if (allEmbeddings[i].length !== EMBEDDING_DIM) {
      throw new Error(
        `Embedding dimension mismatch at index ${i}: expected ${EMBEDDING_DIM}, got ${allEmbeddings[i].length}`
      );
    }
  }

  return allEmbeddings;
}

/**
 * Generate a single embedding for a query string.
 * Uses RETRIEVAL_QUERY task type for optimal search retrieval.
 *
 * @param {string} queryText - The user's query.
 * @returns {Promise<number[]>} 768-dimensional float array.
 */
export async function embedQuery(queryText) {
  const [embedding] = await generateEmbeddings([queryText], 'RETRIEVAL_QUERY');
  return embedding;
}

export { EMBEDDING_DIM, EMBEDDING_MODEL };
