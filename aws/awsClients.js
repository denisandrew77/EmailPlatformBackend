import { SESClient } from "@aws-sdk/client-ses";
import { SQSClient } from "@aws-sdk/client-sqs";

const region = process.env.AWS_REGION;

export const sqsClient = new SQSClient({ region });
export const sesClient = new SESClient({ region });
