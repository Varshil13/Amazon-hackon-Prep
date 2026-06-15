import { NextResponse } from 'next/server';
import { dynamoDb, isAwsConfigured } from '@/lib/dynamodb';
import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

export const dynamic = 'force-dynamic';

// 5 days of realistic Indian household patterns
// Morning: geyser + bedroom_light (7AM), water_motor (7:15AM), puja bell (7:30AM)
// Afternoon: pressure_cooker_whistle (1PM), kitchen_light on
// Evening: study_lamp on (6PM), TV on (8PM)
const SEED_EVENTS = [
  // Day 1
  { time: '07:00', message: 'State: ON=[bedroom_light,geyser]', type: 'state_snapshot' },
  { time: '07:15', message: 'State: ON=[bedroom_light,geyser,water_motor]', type: 'state_snapshot' },
  { time: '07:30', message: 'Detected: morning_puja_bell', type: 'trigger' },
  { time: '01:00 PM', message: 'Detected: pressure_cooker_whistle', type: 'trigger' },
  { time: '06:00 PM', message: 'State: ON=[study_lamp]', type: 'state_snapshot' },
  { time: '08:00 PM', message: 'State: ON=[tv,living_light]', type: 'state_snapshot' },
  // Day 2
  { time: '06:55', message: 'State: ON=[bedroom_light]', type: 'state_snapshot' },
  { time: '07:05', message: 'State: ON=[bedroom_light,geyser]', type: 'state_snapshot' },
  { time: '07:18', message: 'Detected: water_motor_on', type: 'trigger' },
  { time: '07:32', message: 'Detected: morning_puja_bell', type: 'trigger' },
  { time: '12:45 PM', message: 'Detected: pressure_cooker_whistle', type: 'trigger' },
  { time: '06:10 PM', message: 'State: ON=[study_lamp,study_ceiling_light]', type: 'state_snapshot' },
  // Day 3
  { time: '07:02', message: 'State: ON=[bedroom_light,geyser]', type: 'state_snapshot' },
  { time: '07:20', message: 'Detected: water_motor_on', type: 'trigger' },
  { time: '07:28', message: 'Detected: morning_puja_bell', type: 'trigger' },
  { time: '01:15 PM', message: 'Detected: pressure_cooker_whistle', type: 'trigger' },
  { time: '05:55 PM', message: 'State: ON=[study_lamp]', type: 'state_snapshot' },
  { time: '08:30 PM', message: 'State: ON=[tv]', type: 'state_snapshot' },
  // Day 4
  { time: '07:10', message: 'State: ON=[bedroom_light,geyser]', type: 'state_snapshot' },
  { time: '07:22', message: 'Detected: water_motor_on', type: 'trigger' },
  { time: '07:35', message: 'Detected: morning_puja_bell', type: 'trigger' },
  { time: '01:00 PM', message: 'Detected: pressure_cooker_whistle', type: 'trigger' },
  { time: '06:05 PM', message: 'State: ON=[study_lamp]', type: 'state_snapshot' },
  // Day 5
  { time: '06:58', message: 'State: ON=[bedroom_light,geyser]', type: 'state_snapshot' },
  { time: '07:12', message: 'Detected: water_motor_on', type: 'trigger' },
  { time: '07:29', message: 'Detected: morning_puja_bell', type: 'trigger' },
  { time: '12:55 PM', message: 'Detected: pressure_cooker_whistle', type: 'trigger' },
  { time: '06:00 PM', message: 'State: ON=[study_lamp]', type: 'state_snapshot' },
  { time: '08:15 PM', message: 'State: ON=[tv,living_light]', type: 'state_snapshot' },
];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const force = searchParams.get("force") === "true";

  if (!isAwsConfigured) {
    return NextResponse.json({ success: false, reason: 'AWS not configured' });
  }

  try {
    // Skip if already seeded — unless ?force=true (for demo resets)
    if (!force) {
      const existing = await dynamoDb.send(new ScanCommand({
        TableName: 'HouseholdLogs',
        Limit: 5,
      }));
      if ((existing.Items?.length ?? 0) >= 5) {
        return NextResponse.json({ success: true, message: 'Already seeded — add ?force=true to reseed' });
      }
    }

    // Write all seed events
    const baseTimestamp = Date.now() - (5 * 24 * 60 * 60 * 1000); // 5 days ago
    await Promise.all(
      SEED_EVENTS.map((event, i) =>
        dynamoDb.send(new PutCommand({
          TableName: 'HouseholdLogs',
          Item: {
            id: `seed_${i}_${baseTimestamp + i * 1000}`,
            timestamp: baseTimestamp + i * 60000,
            message: event.message,
            time: event.time,
            type: event.type,
            source: 'parents',
            target: 'everyone',
          },
        }))
      )
    );

    return NextResponse.json({ success: true, message: `Seeded ${SEED_EVENTS.length} events` });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
