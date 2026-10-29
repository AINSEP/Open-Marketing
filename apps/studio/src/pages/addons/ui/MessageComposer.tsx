/** Owner message composer; sending always goes through om_message_send and its exact Allow/Cancel card. */
import { useMessageComposer } from '../model/message-composer.hooks.js';
import type { MessageComposerProps } from '../model/message-composer.hooks.js';
import { ApprovalCard } from '../../../features/approve/index.js';

export function MessageComposer(props: MessageComposerProps) {
  const composer = useMessageComposer(props);
  return <section className="settings-card" aria-label="Send a message"><h2>Send a message</h2>
    {props.connectionsError && <p role="status" className="error-notice">{props.connectionsError}</p>}
    {!props.connections.length && !props.connectionsError && <p className="muted">No messaging connection is available. Save credentials and bind the account first.</p>}
    <form onSubmit={composer.submit}><fieldset disabled={composer.locked}>
      <label>Contact phone<input type="tel" value={composer.phone} onChange={composer.changePhone} maxLength={16} placeholder="+15555550100" /></label>
      <button type="button" onClick={composer.lookup} disabled={!composer.phone}>Find contact</button>
      {composer.contact && <p role="status">OM contact {composer.contact.subjectId}</p>}
      <label>Connection<select value={composer.connection} onChange={composer.changeConnection}>
        {composer.options.map(renderOption)}
      </select></label>
      <label>Message<textarea value={composer.content} onChange={composer.changeText} onBlur={composer.preview} maxLength={1600} rows={4} /></label>
      {composer.segments !== null && <p>{composer.segments} {composer.segments === 1 ? 'segment' : 'segments'}</p>}
      <label>Consent purpose<input value={composer.purpose} onChange={composer.changePurpose} maxLength={256} /></label>
      <label>Intent<select value={composer.intent} onChange={composer.changeIntent}>
        <option value="marketing">Marketing</option><option value="transactional">Transactional</option>
      </select></label>
      <label>Maximum cost (USD cents)<input type="number" min={1} step={1} value={composer.maxCost} onChange={composer.changeMaxCost} /></label>
      <button type="submit" className="primary-button">Review and send</button>
    </fieldset></form>
    {composer.status && <p role="status">{composer.status}</p>}
    {composer.card && <ApprovalCard key={composer.card.cardId} card={composer.card} api={props.api} runtime={props.runtime} sample={false} />}
    {composer.operationId && <button type="button" onClick={composer.checkStatus} disabled={composer.busy}>Check send status</button>}
  </section>;
}
/** Native option list-render ABI; labels are prepared by the hook. */
function renderOption(option: { key: string; label: string }) {
  return <option key={option.key} value={option.key}>{option.label}</option>;
}
