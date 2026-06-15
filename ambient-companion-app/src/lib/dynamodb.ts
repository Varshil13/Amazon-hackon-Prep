import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Amplify reserves the "AWS_" env-var prefix, so in the cloud our keys are
// stored as APP_AWS_*. Locally (.env.local) the classic AWS_* names still work.
const accessKeyId = process.env.APP_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || "dummy";
const secretAccessKey = process.env.APP_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || "dummy";
const region = process.env.APP_AWS_REGION || process.env.AWS_REGION || "us-east-1";

const client = new DynamoDBClient({
  region,
  credentials: { accessKeyId, secretAccessKey },
});

export const dynamoDb = DynamoDBDocumentClient.from(client);

// True when real AWS credentials are present (under either the APP_AWS_* name
// used on Amplify or the classic AWS_* name used locally).
export const isAwsConfigured =
  !!accessKeyId &&
  accessKeyId !== "dummy" &&
  accessKeyId !== "paste_your_access_key_here";
