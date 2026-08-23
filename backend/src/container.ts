import { config } from './config/env.js';
import { DynamoDocumentRepository } from './repositories/dynamoDocumentRepository.js';
import { MemoryDocumentRepository } from './repositories/memoryDocumentRepository.js';
import type { DocumentRepository } from './repositories/documentRepository.js';
import { DocumentService } from './services/documentService.js';
import { ExtractionService } from './services/extractionService.js';
import { createStorageService, type StorageService } from './services/storageService.js';
import { logger } from './utils/logger.js';

export interface Container {
  repository: DocumentRepository;
  storage: StorageService;
  documents: DocumentService;
}

/**
 * Wires the concrete adapters once at boot. Everything downstream depends on
 * interfaces, which is what lets the same code run with or without AWS.
 */
export async function createContainer(): Promise<Container> {
  const repository: DocumentRepository =
    config.features.dynamo && config.aws.dynamoTable
      ? new DynamoDocumentRepository(config.aws.dynamoTable)
      : await MemoryDocumentRepository.create(config.localDbFile);

  const storage = createStorageService();
  const documents = new DocumentService(repository, storage, new ExtractionService());

  logger.info('LedgerFlow container ready', {
    repository: repository.name,
    storage: storage.name,
    textract: config.features.textract,
    bedrock: config.features.bedrock,
  });

  return { repository, storage, documents };
}
