// Demo data. Idempotent: safe to run on every container start.
// Sample batches are created through the real domain services (not raw
// inserts), so they get audit trails and outbox events like real ones.
import { prisma } from '../src/infra';
import { createBatch, decide, replaceCandidates, submitBatch } from '../src/domain/batchService';
import { Actor } from '../src/domain/workflow';
import { ValidCandidate } from '../src/domain/spreadsheet';

const FIRST = ['Aarav', 'Diya', 'Rohan', 'Isha', 'Kiran', 'Pooja', 'Arjun', 'Sneha', 'Vikram', 'Neel', 'Tara', 'Manav'];
const LAST = ['Patil', 'Sharma', 'Deshmukh', 'Kulkarni', 'Joshi', 'Shinde', 'Pawar', 'Iyer'];

export function demoCandidates(prefix: string, count: number, phoneStart = 9000000000): ValidCandidate[] {
  return Array.from({ length: count }, (_, i) => ({
    rowNumber: i + 2,
    name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
    enrollmentNo: `${prefix}-${String(i + 1).padStart(4, '0')}`,
    phone: `+91${phoneStart + i}`,
    dateOfBirth: new Date(Date.UTC(2000 + (i % 6), i % 12, (i % 27) + 1)),
    grade: ['A', 'B', 'C', 'D'][i % 4],
  }));
}

export async function seedReferenceData() {
  await prisma.district.upsert({ where: { id: 'pune' }, update: {}, create: { id: 'pune', name: 'Pune' } });
  await prisma.district.upsert({ where: { id: 'nashik' }, update: {}, create: { id: 'nashik', name: 'Nashik' } });
  await prisma.centre.upsert({
    where: { id: 'centre-pune-1' },
    update: {},
    create: { id: 'centre-pune-1', name: 'Pragati Skills Centre, Hadapsar', districtId: 'pune' },
  });
  await prisma.centre.upsert({
    where: { id: 'centre-nashik-1' },
    update: {},
    create: { id: 'centre-nashik-1', name: 'Godavari Training Institute', districtId: 'nashik' },
  });
  const users = [
    { id: 'anika', name: 'Anika', role: 'CENTRE', centreId: 'centre-pune-1', districtId: 'pune' },
    { id: 'dev', name: 'Dev', role: 'OFFICER', districtId: 'pune' },
    { id: 'meera', name: 'Meera', role: 'OFFICER', districtId: 'pune' },
    { id: 'kabir', name: 'Kabir', role: 'OFFICER', districtId: 'pune' },
    { id: 'neha', name: 'Neha', role: 'QUALITY' },
    { id: 'farah', name: 'Farah', role: 'STATE' },
    // Extra users that prove district / centre isolation.
    { id: 'ravi', name: 'Ravi (Nashik officer)', role: 'OFFICER', districtId: 'nashik' },
    { id: 'ishaan', name: 'Ishaan (Nashik centre)', role: 'CENTRE', centreId: 'centre-nashik-1', districtId: 'nashik' },
  ] as const;
  for (const u of users) {
    await prisma.user.upsert({ where: { id: u.id }, update: {}, create: { ...u } });
  }
}

async function actor(id: string): Promise<Actor> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id: u.id, name: u.name, role: u.role, districtId: u.districtId, centreId: u.centreId };
}

async function seedDemoBatches() {
  if ((await prisma.batch.count()) > 0) return;
  const [anika, dev, meera, neha, farah] = await Promise.all(['anika', 'dev', 'meera', 'neha', 'farah'].map(actor));

  // 1. Draft, ready for Anika to upload / submit.
  await createBatch(anika, { title: 'Electrician - March cohort', course: 'Assistant Electrician (NSQF L3)' });

  // 2. Waiting for district: Dev already approved, needs one more officer.
  const b2 = await createBatch(anika, { title: 'Retail Sales - Feb cohort', course: 'Retail Sales Associate (NSQF L4)' });
  await replaceCandidates(anika, b2.id, demoCandidates('PSC-RS26', 8, 9100000000));
  await submitBatch(anika, b2.id);
  await decide(dev, b2.id, { decision: 'APPROVE', revision: 1 });

  // 3. Large batch (60) waiting for the state office after quality review.
  const b3 = await createBatch(anika, { title: 'Data Entry - Jan cohort', course: 'Data Entry Operator (NSQF L4)' });
  await replaceCandidates(anika, b3.id, demoCandidates('PSC-DE26', 60, 9200000000));
  await submitBatch(anika, b3.id);
  await decide(dev, b3.id, { decision: 'APPROVE', revision: 1 });
  await decide(meera, b3.id, { decision: 'APPROVE', revision: 1 });
  await decide(neha, b3.id, { decision: 'APPROVE', revision: 1 });

  // 4. Fully approved small batch: certificates issued and sent by the worker.
  const b4 = await createBatch(anika, { title: 'Beauty & Wellness - Dec cohort', course: 'Assistant Beauty Therapist (NSQF L3)' });
  await replaceCandidates(anika, b4.id, demoCandidates('PSC-BW25', 5, 9300000000));
  await submitBatch(anika, b4.id);
  await decide(dev, b4.id, { decision: 'APPROVE', revision: 1 });
  await decide(meera, b4.id, { decision: 'APPROVE', revision: 1 });
  await decide(farah, b4.id, { decision: 'APPROVE', revision: 1 });

  // 5. Stuck: submitted 3 days ago, untouched. The SLA sweep escalates it.
  const b5 = await createBatch(anika, { title: 'Welding - Nov cohort', course: 'Welder (NSQF L3)' });
  await replaceCandidates(anika, b5.id, demoCandidates('PSC-WD25', 6, 9400000000));
  await submitBatch(anika, b5.id);
  await prisma.batch.update({ where: { id: b5.id }, data: { stageEnteredAt: new Date(Date.now() - 3 * 86400_000) } });
}

async function main() {
  await seedReferenceData();
  await seedDemoBatches();
  console.log('seed complete');
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect().then(() => process.exit(0)));
}
