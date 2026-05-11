import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, Loader2, Send, Sparkles, Target, Zap } from 'lucide-react';
import { ErrorState } from '@/components/state-display/StateDisplay';
import { useCurrentActorId } from '@/hooks/useCurrentActorId';
import { requireActorId } from '@/services/session.service';
import {
  BLAST_RADIUS_VALUES,
  DEFAULT_EXPIRES,
  DEFAULT_MIN_CONFIDENCE,
  EXPIRES_PRESETS,
  SCOPE_VALUES,
  SUB_ACTOR_VALUES,
  fileIntent,
  isFormValid,
  validateFileIntentForm,
  type BlastRadius,
  type FileIntentResponse,
  type Scope,
  type SubActor,
} from './fileIntent.service';
import { routeForAtomId, setRoute } from '@/state/router.store';
import styles from './FileIntentPanel.module.css';

/**
 * File-intent panel -- the Console UX for writing an operator-intent
 * atom that drives the autonomous pipeline. Replaces the terminal-only
 * `node scripts/intend.mjs` flow.
 *
 * Form fields mirror the CLI argv (request / scope / blast-radius /
 * sub-actors / min-confidence / expires-in / trigger) so a Console-filed
 * intent is byte-for-byte equivalent to a CLI-filed one. The substrate
 * gate is enforced server-side: the canon
 * `pol-operator-intent-creation.allowed_principal_ids` list governs
 * who may author one, and a non-whitelisted operator gets a typed
 * 403 here.
 *
 * Mobile-first: starts single-column at 390x844 with 44px touch
 * targets on every control. Submit shows in-flight state via the
 * mutation isPending flag; success swaps the form for a success
 * card with a "View intent" link that routes to the atom detail
 * view + auto-dismisses after 3s, returning focus to the textarea
 * so the operator can file another intent without a mouse click.
 */
export function FileIntentPanel() {
  const qc = useQueryClient();
  const actorId = useCurrentActorId();

  const [request, setRequest] = useState('');
  const [scope, setScope] = useState<Scope>('tooling');
  const [blastRadius, setBlastRadius] = useState<BlastRadius>('tooling');
  const [subActors, setSubActors] = useState<ReadonlyArray<SubActor>>(['code-author']);
  const [minConfidence, setMinConfidence] = useState(DEFAULT_MIN_CONFIDENCE);
  const [expiresIn, setExpiresIn] = useState(DEFAULT_EXPIRES);
  const [trigger, setTrigger] = useState(true);
  const [showSuccessToast, setShowSuccessToast] = useState(false);
  const requestRef = useRef<HTMLTextAreaElement | null>(null);

  const mutation = useMutation<FileIntentResponse, Error, void>({
    mutationFn: () => {
      /*
       * Fail loud if LAG_CONSOLE_ACTOR_ID is unset or blank. The
       * server enforces the same gate (returns 500 console-actor-id-unset
       * when the env is missing), but the client-side requireActorId
       * call surfaces the gap as an immediate operator-facing error
       * with a remediation pointer instead of round-tripping a 500.
       * Per canon `dev-framework-mechanism-only`, a governance write
       * with no resolved operator identity must NEVER silently proceed.
       */
      requireActorId(actorId);
      return fileIntent({
        request: request.trim(),
        scope,
        blast_radius: blastRadius,
        sub_actors: subActors,
        min_confidence: minConfidence,
        expires_in: expiresIn,
        trigger,
      });
    },
    onSuccess: () => {
      // The intent atom shows up in the activities feed + may seed a
      // new pipeline atom. Invalidate both so the operator sees the
      // ripple immediately rather than after a refresh.
      qc.invalidateQueries({ queryKey: ['activities'] });
      qc.invalidateQueries({ queryKey: ['pipelines'] });
      qc.invalidateQueries({ queryKey: ['canon'] });
      setShowSuccessToast(true);
    },
  });

  // Inline form validation (debounced). The mutation's own onError
  // path covers network-tier failures; this catches malformed input
  // before we even round-trip.
  const errors = validateFileIntentForm({ request, subActors });
  const canSubmit = isFormValid(errors)
    && !mutation.isPending
    && actorId !== null;

  /*
   * Success behaviour:
   *   - Auto-dismiss the toast after 3s.
   *   - Reset the form to a fresh state.
   *   - Return focus to the request textarea so the operator can file
   *     a second intent without grabbing the mouse.
   * Mutation reset cycles the isSuccess flag so the form re-renders.
   */
  useEffect(() => {
    if (!showSuccessToast) return;
    const timer = setTimeout(() => {
      setShowSuccessToast(false);
      // Reset the request body but preserve scope / blast-radius /
      // sub-actors / etc -- the operator usually files several intents
      // in the same envelope before swapping shape.
      setRequest('');
      mutation.reset();
      requestRef.current?.focus();
    }, 3000);
    return () => clearTimeout(timer);
  }, [showSuccessToast, mutation]);

  const handleSubActorToggle = (actor: SubActor) => {
    setSubActors((prev) => {
      if (prev.includes(actor)) {
        return prev.filter((a) => a !== actor);
      }
      return [...prev, actor];
    });
  };

  const handleViewIntent = () => {
    if (!mutation.data) return;
    const id = mutation.data.intent_id;
    const route = routeForAtomId(id);
    setRoute(route, id);
  };

  return (
    <div className={styles.view} data-testid="file-intent-view">
      <header className={styles.intro}>
        <h1 className={styles.heroTitle}>
          <Target size={28} strokeWidth={1.75} aria-hidden="true" />
          File an intent
        </h1>
        <p className={styles.heroSubtitle}>
          Declare what you want done; the substrate writes an{' '}
          <code className={styles.inlineCode}>operator-intent</code> atom and
          (optionally) kicks the autonomous pipeline. The five-stage planner
          drafts a plan, the auditor verifies its citations, and a code-author
          opens the PR. Operator-authored intents are the authorization
          (canon <code className={styles.inlineCode}>pol-plan-autonomous-intent-approve</code>).
        </p>
      </header>

      {actorId === null && (
        <ErrorState
          title="Operator identity not configured"
          message="The backend is not set with LAG_CONSOLE_ACTOR_ID. Set it to the operator principal id and restart `npm run dev:server`."
          testId="file-intent-no-actor"
        />
      )}

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          mutation.mutate();
        }}
        data-testid="file-intent-form"
      >
        <label className={styles.field}>
          <span className={styles.label}>What do you want done?</span>
          <textarea
            ref={requestRef}
            className={styles.textarea}
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder="One paragraph: the desired outcome, the surface affected, any constraints. The planner reads this verbatim."
            rows={5}
            data-testid="file-intent-request"
            aria-invalid={errors.request !== undefined}
            aria-describedby={errors.request ? 'file-intent-request-error' : undefined}
          />
          {errors.request && (
            <span className={styles.fieldError} id="file-intent-request-error" data-testid="file-intent-request-error">
              {errors.request}
            </span>
          )}
        </label>

        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>Scope</span>
            <select
              className={styles.select}
              value={scope}
              onChange={(e) => setScope(e.target.value as Scope)}
              data-testid="file-intent-scope"
            >
              {SCOPE_VALUES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <span className={styles.fieldFoot}>
              Where the change lives. <code className={styles.inlineCode}>framework</code>{' '}
              is high blast-radius; default to <code className={styles.inlineCode}>tooling</code>{' '}
              unless you know otherwise.
            </span>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Max blast radius</span>
            <select
              className={styles.select}
              value={blastRadius}
              onChange={(e) => setBlastRadius(e.target.value as BlastRadius)}
              data-testid="file-intent-blast-radius"
            >
              {BLAST_RADIUS_VALUES.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
            <span className={styles.fieldFoot}>
              Substrate fence: plans whose blast-radius exceeds this never get
              auto-approved.
            </span>
          </label>
        </div>

        <fieldset className={styles.fieldset}>
          <legend className={styles.label}>Allowed sub-actors</legend>
          <div className={styles.checkboxRow}>
            {SUB_ACTOR_VALUES.map((actor) => {
              const checked = subActors.includes(actor);
              return (
                <label
                  key={actor}
                  className={`${styles.checkbox} ${checked ? styles.checkboxActive : ''}`}
                  data-testid={`file-intent-sub-actor-${actor}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => handleSubActorToggle(actor)}
                    className={styles.checkboxInput}
                  />
                  <span className={styles.checkboxLabel}>
                    {actor === 'code-author' ? (
                      <>
                        <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
                        code-author
                      </>
                    ) : (
                      <>
                        <Zap size={14} strokeWidth={1.75} aria-hidden="true" />
                        auditor-actor
                      </>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
          {errors.subActors && (
            <span className={styles.fieldError} data-testid="file-intent-sub-actors-error">
              {errors.subActors}
            </span>
          )}
          <span className={styles.fieldFoot}>
            Sub-actors named here may carry out the plan; an envelope mismatch
            (plan delegates to an actor not on this list) fails the approval
            tick at the substrate boundary.
          </span>
        </fieldset>

        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.labelWithValue}>
              <span>Min plan confidence</span>
              <span className={styles.valueChip} data-testid="file-intent-confidence-value">
                {minConfidence.toFixed(2)}
              </span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={minConfidence}
              onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
              className={styles.range}
              data-testid="file-intent-confidence"
              aria-label="Minimum plan confidence"
            />
            <span className={styles.fieldFoot}>
              Plans below this threshold do not auto-approve. 0.75 is the
              canonical floor.
            </span>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Expires in</span>
            <select
              className={styles.select}
              value={expiresIn}
              onChange={(e) => setExpiresIn(e.target.value)}
              data-testid="file-intent-expires"
            >
              {EXPIRES_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            <span className={styles.fieldFoot}>
              After this window the intent stops authorizing approvals.
            </span>
          </label>
        </div>

        <label className={`${styles.toggle} ${trigger ? styles.toggleActive : ''}`} data-testid="file-intent-trigger-toggle">
          <input
            type="checkbox"
            checked={trigger}
            onChange={(e) => setTrigger(e.target.checked)}
            className={styles.checkboxInput}
          />
          <span className={styles.toggleLabel}>
            <Zap size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>
              <span className={styles.toggleTitle}>Trigger pipeline now</span>
              <span className={styles.toggleHint}>
                Spawns the autonomous CTO + planner against this intent
                immediately. Uncheck to file without kicking the pipeline.
              </span>
            </span>
          </span>
        </label>

        {mutation.isError && !showSuccessToast && (
          <div className={styles.error} data-testid="file-intent-error">
            <span className={styles.errorTitle}>Could not file the intent</span>
            <span className={styles.errorMessage}>{mutation.error.message}</span>
          </div>
        )}

        <div className={styles.actions}>
          <button
            type="submit"
            className={styles.primaryBtn}
            disabled={!canSubmit}
            data-testid="file-intent-submit"
            aria-busy={mutation.isPending}
          >
            {mutation.isPending ? (
              <>
                <Loader2 size={16} strokeWidth={2} aria-hidden="true" className={styles.spin} />
                Filing intent...
              </>
            ) : (
              <>
                <Send size={16} strokeWidth={2} aria-hidden="true" />
                File intent
              </>
            )}
          </button>
        </div>
      </form>

      <AnimatePresence>
        {showSuccessToast && mutation.data && (
          <motion.div
            className={styles.toast}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            role="status"
            data-testid="file-intent-toast"
          >
            <CheckCircle2 size={20} strokeWidth={1.75} className={styles.toastIcon} aria-hidden="true" />
            <div className={styles.toastBody}>
              <div className={styles.toastTitle}>Intent filed</div>
              <div className={styles.toastDetail}>
                <code className={styles.intentId} data-testid="file-intent-toast-id">{mutation.data.intent_id}</code>
                {mutation.data.triggered ? ' -- pipeline kicked' : ' -- no trigger'}
              </div>
            </div>
            <button
              type="button"
              className={styles.toastAction}
              onClick={handleViewIntent}
              data-testid="file-intent-toast-view"
            >
              View intent
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
