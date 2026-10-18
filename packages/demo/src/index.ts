import { type JobView, type JobWorkflow } from '@architecture-studies/contracts';
import { LayeredWorkflow } from '@architecture-studies/layered';
import { HexagonalWorkflow } from '@architecture-studies/hex-adapters';
import { EventDrivenWorkflow } from '@architecture-studies/event-driven';

const studies: [string, JobWorkflow][] = [
  ['Layered', new LayeredWorkflow()],
  ['Ports and adapters', new HexagonalWorkflow()],
  ['CQRS and in-process events', new EventDrivenWorkflow()],
];

function show(job: JobView): string { return `${job.state} | attempts=${job.attemptCount} | version=${job.version}`; }
for (const [name, workflow] of studies) {
  console.log(`\n${name}`);
  const job = workflow.submit('research-team', 'upload-001', 'synthetic-note.txt');
  console.log('submit  ', show(job));
  console.log('start   ', show(workflow.start('research-team', job.id)));
  console.log('fail    ', show(workflow.fail('research-team', job.id, 'Simulated worker failure')));
  console.log('retry   ', show(workflow.retry('research-team', job.id)));
  console.log('start   ', show(workflow.start('research-team', job.id)));
  console.log('complete', show(workflow.complete('research-team', job.id, 'Text supplied by the demo; no OCR ran.')));
  const duplicate = workflow.submit('research-team', 'upload-001', 'synthetic-note.txt');
  console.log('resubmit', `same id=${duplicate.id === job.id} | ${show(duplicate)}`);
  console.log('other tenant sees', workflow.list('unrelated-team').length, 'jobs');
}

const delayed = new EventDrivenWorkflow({ autoProject: false });
const pending = delayed.submit('research-team', 'lag-001', 'projection-example.txt');
console.log('\nProjection lag: query list before delivery =', delayed.list('research-team').length);
delayed.projectPending();
delayed.start('research-team', pending.id);
console.log('After start, stale read =', delayed.get('research-team', pending.id).state);
delayed.projectPending();
console.log('After delivery, read =', delayed.get('research-team', pending.id).state);
delayed.rebuildProjection();
console.log('After rebuild, read =', delayed.get('research-team', pending.id).state);
