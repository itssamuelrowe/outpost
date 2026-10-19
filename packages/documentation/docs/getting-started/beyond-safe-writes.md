---
id: beyond-safe-writes
title: What you get beyond safe writes
---

# What you get beyond safe writes

Even when your writes are already safe, Outpost still earns its place. Suppose you have done the work: every external call is idempotent, and each local write sits in a transaction. That closes the "done it twice" problem for a single step. It still leaves a lot of a real multi-step process for you to build by hand. Here is what you get for free once the steps live inside Outpost.

If you have not yet decided whether you need durable execution at all, start with [Do you even need this?](./do-you-need-this.md); this page assumes you already make single actions safe and asks what a durable engine adds on top.

## Durable sleeps that outlive the process

Some processes have to wait. "Hold the order for two hours, then ship." "Wait a day, then send a reminder." A database transaction cannot hold a lock for two hours, and a cron job re-derives state you already had and has to figure out where each job was.

Outpost lets a workflow sleep durably: it records the timer, lets the process exit, and resumes the workflow when the time is due, even on a different machine. Your code reads as if it simply waited, but nothing is held open in the meantime. See [Durable sleep](../scheduling/durable-sleep.md).

## Durable cron that survives restarts

The other side of "wait, then act" is "act on a schedule." A system `cron` entry or a `setInterval` fires on one machine, in memory, with no record of what happened: if that machine is down at the fire time the run is simply lost, and in a fleet either every instance fires (duplicate work) or you nominate one special box (a single point of failure). Neither an idempotency key nor a transaction helps here; they make an action safe, they do not schedule it.

Outpost runs a workflow on a recurring schedule that lives in your database. Any process can fire it, exactly one wins the claim, missed windows can be replayed on recovery, and the workflow it starts is itself durable, so a crash mid-run resumes where it left off. You get time-zone-aware expressions, catch-up, and pause/resume/backfill without standing up a scheduler service. See [Durable cron](../scheduling/durable-cron.md).

## Chaos testing your recovery paths

You can write an idempotency key. Have you proven it holds when the process dies in the exact window between the call and the commit? Recovery code is the least-tested code you own, because the failures that trigger it are rare and hard to reproduce on purpose.

Outpost lets you inject those failures deterministically: fail a step before it runs, fail it after the side effect but before the commit, expire a lease, or crash between attempts. You turn "I think this recovers" into a test that runs in CI. See [Chaos testing](../concepts/chaos-testing.md).

## Retries and backoff you do not hand-roll

An idempotency key makes a retry _safe_. It does not _schedule_ one. You still have to decide how many times to try, how long to wait between attempts, and how to keep that state across a restart.

Each Outpost step takes an attempt budget and a backoff policy with exponential growth and jitter, and the retry state is persisted, so a restart does not reset the counter or fire every retry at once. See [Retries and backoff](../concepts/retries-and-backoff.md).

## An audit trail of what actually happened

When an order goes wrong at 2am, transactions and idempotency keys leave you grepping application logs to reconstruct the story. Outpost records an immutable event for every material transition: a step started, completed, was retried, failed, or was probed. You can see exactly how far a given workflow got and where it stalled, without adding logging to each step yourself.

## Optional steps with fallbacks

Not every step deserves to fail the whole job. A fraud score should not hold up checkout, and a best-effort sync should not sink an order that otherwise succeeded. Building that yourself means wrapping each such call in its own try/catch and threading a "did it work?" flag through the rest of the process.

Outpost makes this part of a step's configuration: mark a step `optional` with a `fallbackValue`, and a terminal failure yields the fallback and lets the workflow continue instead of failing it. You express the intent and the engine handles the plumbing.

## The honest summary

| Your situation                                             | Best tool                   |
| ---------------------------------------------------------- | --------------------------- |
| One call to one service, safe to repeat                    | Idempotency key             |
| Several changes in one database, all-or-nothing            | A transaction               |
| Several steps, across systems, surviving crashes and waits | Durable execution (Outpost) |

Notice that the simpler tools do not disappear when you use Outpost. Idempotency keys, for instance, become an ingredient: Outpost uses them inside a [probe](../concepts/ambiguous-state-and-probes.md) to check whether a step already happened. Outpost does not replace these tools; it coordinates them across the whole process.

If your problem really is a single idempotent call in a single transaction, use those and move on. If "did we finish, and how far did we get?" is a question your code keeps having to answer, Outpost is built for exactly that.
