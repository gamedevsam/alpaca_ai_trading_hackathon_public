/**
 * The submission's 16:9 cover image, rendered rather than drawn — so the numbers on it can
 * be re-read off the running desk and the file regenerated, instead of drifting from the
 * record the moment the desk trades again.
 *
 * Exported to `public/hackathon/cover.png` by screenshotting a 1920x1080 viewport, at which
 * width the frame fills it exactly. Every figure below is read from
 * https://alpaca-ai-hackathon.dataconnector-pro.com/desk on 2026-09-03, and the refusal is
 * the desk's own stored wording, verbatim.
 */

const ACCOUNT_ID = 'PA3R6NNBYGML';

/** Three numbers, chosen because the middle one is the claim the project is making. */
const FIGURES = [
  ['21', 'named ceilings, scored on every order and run twice'],
  ['11', 'of 16 proposals stopped by one of them'],
  ['1', 'LLM call a cycle — and none of it inside the gates'],
];

export default function CoverPage() {
  return (
    <main className="cover">
      <div className="cover-frame">
        <div className="cover-inner">
          <div className="cover-identity">
            <p className="cover-kicker">Alpaca AI Trading Agents Hackathon · September 2026</p>
            <p className="cover-wordmark">MANDATE</p>
            <p className="cover-tagline">The autonomous options desk that can prove it obeyed.</p>
            <p className="cover-lead">
              An LLM proposes. Deterministic code disposes. Every order carries the record of the rules it was measured
              against — including the ones it failed.
            </p>
          </div>

          <div className="cover-proof">
            <div className="cover-refusal">
              <p className="cover-refusal-label">Discarded · defined_risk_floor</p>
              <p className="cover-refusal-quote">
                NAKED PUT REJECTED: $29,100.00 needed to secure, only $0.00 available.
              </p>
            </div>
            <div className="cover-figures">
              {FIGURES.map(([value, label]) => (
                <div key={label} className="cover-figure">
                  <p className="cover-figure-value">{value}</p>
                  <p className="cover-figure-label">{label}</p>
                </div>
              ))}
            </div>
          </div>

          <p className="cover-footer">
            <strong>Samuel Batista</strong>
            <span>
              Alpaca paper account <code>{ACCOUNT_ID}</code>
            </span>
            <span>Simulated money — never pointed at a live account</span>
          </p>
        </div>
      </div>
    </main>
  );
}
