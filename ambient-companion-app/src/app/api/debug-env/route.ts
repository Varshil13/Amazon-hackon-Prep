import { NextResponse } from "next/server";

// TEMPORARY diagnostic endpoint. Returns presence booleans only — never the
// secret values. Remove once deployment env vars are confirmed working.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    groqKeyPresent: !!process.env.GROQ_API_KEY,
    appAwsKeyPresent: !!process.env.APP_AWS_ACCESS_KEY_ID,
    appAwsSecretPresent: !!process.env.APP_AWS_SECRET_ACCESS_KEY,
    appAwsRegion: process.env.APP_AWS_REGION || null,
    lambdaAwsKeyPresent: !!process.env.AWS_ACCESS_KEY_ID,
    nodeEnv: process.env.NODE_ENV || null,
  });
}
