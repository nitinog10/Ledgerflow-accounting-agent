// Load backend/.env before anything reads process.env. Harmless when the file
// is absent (deployed environments set real variables instead).
import 'dotenv/config';
import { z } from 'zod';

/**
 * Configuration is deliberately forgiving: LedgerFlow must boot and run the
 * full demo with no AWS account at all. Each AWS-backed capability turns on
 * only when its inputs are present, and reports itself through /health.
 */
const toggle = z.enum(['auto', 'true', 'false']).default('auto');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  ORG_ID: z.string().default('demo'),
  CORS_ORIGIN: z.string().default('*'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(15),

  AWS_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  DYNAMODB_TABLE: z.string().optional(),
  BEDROCK_MODEL_ID: z.string().default('us.amazon.nova-lite-v1:0'),
  /** Bedrock may live in a different region than the data (model availability). */
  BEDROCK_REGION: z.string().optional(),

  /** "auto" enables the service only when AWS credentials look reachable. */
  ENABLE_TEXTRACT: toggle,
  ENABLE_BEDROCK: toggle,

  /** Where local-disk storage writes files when S3 is not configured. */
  LOCAL_STORAGE_DIR: z.string().default('.data/uploads'),
  /** Persist the in-memory repository to this JSON file so restarts keep the inbox. */
  LOCAL_DB_FILE: z.string().default('.data/documents.json'),

  /** Vendor notifications. SMTP is optional; without it emails are simulated. */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  /** Where vendor-facing emails (missing details, decline notices) are sent. */
  VENDOR_NOTIFY_EMAIL: z.string().email().default('nitiniszod10@gmail.com'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${issues}`);
}

const raw = parsed.data;

/**
 * True when the default AWS credential chain has something to work with.
 * App Runner and ECS inject container credential variables; a laptop uses
 * static keys or a named profile.
 */
function awsCredentialsLikelyAvailable(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_PROFILE ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
      process.env.AWS_ROLE_ARN,
  );
}

function resolveToggle(value: 'auto' | 'true' | 'false', autoValue: boolean): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return autoValue;
}

const credentialsPresent = awsCredentialsLikelyAvailable();

export const config = {
  nodeEnv: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  port: raw.PORT,
  logLevel: raw.LOG_LEVEL,

  orgId: raw.ORG_ID,
  corsOrigins: raw.CORS_ORIGIN.split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
  maxUploadBytes: Math.round(raw.MAX_UPLOAD_MB * 1024 * 1024),

  aws: {
    region: raw.AWS_REGION,
    s3Bucket: raw.S3_BUCKET,
    dynamoTable: raw.DYNAMODB_TABLE,
    bedrockModelId: raw.BEDROCK_MODEL_ID,
    bedrockRegion: raw.BEDROCK_REGION ?? raw.AWS_REGION,
    credentialsPresent,
  },

  localStorageDir: raw.LOCAL_STORAGE_DIR,
  localDbFile: raw.LOCAL_DB_FILE,

  email: {
    host: raw.SMTP_HOST,
    port: raw.SMTP_PORT,
    user: raw.SMTP_USER,
    pass: raw.SMTP_PASS,
    from: raw.EMAIL_FROM ?? raw.SMTP_USER ?? 'ledgerflow@localhost',
    vendorEmail: raw.VENDOR_NOTIFY_EMAIL,
  },

  features: {
    s3: Boolean(raw.S3_BUCKET),
    dynamo: Boolean(raw.DYNAMODB_TABLE),
    textract: resolveToggle(raw.ENABLE_TEXTRACT, credentialsPresent),
    bedrock: resolveToggle(raw.ENABLE_BEDROCK, credentialsPresent),
    email: Boolean(raw.SMTP_HOST && raw.SMTP_USER && raw.SMTP_PASS),
  },
} as const;

export type AppConfig = typeof config;
