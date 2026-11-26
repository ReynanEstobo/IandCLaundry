import { quantity } from "../utils/alertText";
import { stockStep } from "../utils/inventoryUnits";
import { SUPPLY_CHOICES, needsAmount, replacementOptions } from "../utils/orderSupplies";

const BADGES = { default: "Shop's usual", substitute: "Other item", customer_own: "Customer's own", none: "Left out" };

// Step 3 of a new order: the supplies each selected service usually uses,
// laid out like the add-ons step. Nothing needs to change for a normal order;
// staff change a supply only when the customer asks.
export default function OrderSupplyChoices({ services, stockItems, onChange, hasSelectedServices }) {
  const withSupplies = services.filter((service) => service.recipe.length > 0);
  if (!withSupplies.length) {
    return (
      <div className="addon-empty-state">
        {hasSelectedServices
          ? "The selected services have no usual supplies set."
          : "Select a service in Step 2 to see the supplies it uses."}
      </div>
    );
  }
  return (
    <div className="addon-service-groups">
      {withSupplies.map((service) => (
        <section key={service.index} className="addon-service-group" aria-labelledby={`supply-service-${service.index}`}>
          <div className="addon-service-heading">
            <span className="addon-service-kicker">Service</span>
            <strong id={`supply-service-${service.index}`}>{service.label}</strong>
            <span className="addon-service-help">
              {service.weightEntered
                ? `Amounts are for ${service.loads} load${service.loads === 1 ? "" : "s"}.`
                : "Amounts are for one load until the weight is entered."}
            </span>
          </div>
          <div className="addon-grid">
            {service.recipe.map((line) => (
              <SupplyCard
                key={line.requirementId}
                line={line}
                service={service}
                stockItems={stockItems}
                onChange={(next) => onChange(service.index, next)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SupplyCard({ line, service, stockItems, onChange }) {
  const current = service.choices?.[line.requirementId];
  const choice = current?.choice || "default";
  const needed = line.quantityPerLoad * service.loads;
  const options = replacementOptions(stockItems, line.item, service.recipe);
  const sameUnit = options.filter((option) => option.unit === line.item.unit);
  const otherUnit = options.filter((option) => option.unit !== line.item.unit);
  const replacement = options.find((option) => String(option.id) === String(current?.itemId));
  const askAmount = needsAmount(line.item, replacement);
  const idPrefix = `supply-${service.index}-${line.requirementId}`;

  function choose(value) {
    const next = { ...(service.choices || {}) };
    if (value === "default") delete next[line.requirementId];
    // With only one item that can stand in, pick it straight away.
    else if (value === "substitute") next[line.requirementId] = { choice: value, itemId: options.length === 1 ? String(options[0].id) : "", amount: "" };
    else next[line.requirementId] = { choice: value };
    onChange(next);
  }

  function updateReplacement(changes) {
    onChange({ ...(service.choices || {}), [line.requirementId]: { choice: "substitute", itemId: current?.itemId || "", amount: current?.amount || "", ...changes } });
  }

  const renderOption = (option, enough) => (
    <option key={option.id} value={option.id} disabled={!enough}>
      {option.name} · {quantity(option.current_stock, option.unit)} in stock{enough ? "" : " (not enough)"}
    </option>
  );

  let status = `${quantity(needed, line.item.unit)} for this service · ${quantity(line.item.current_stock, line.item.unit)} in stock`;
  if (choice === "customer_own") status = "The customer brings their own, so nothing is taken from stock.";
  if (choice === "none") status = "Not used for this customer, so nothing is taken from stock.";
  if (choice === "substitute") {
    if (!replacement) status = "Choose the item to use instead.";
    else if (!askAmount) status = `${replacement.name} will be used instead · ${quantity(needed, line.item.unit)} for this service`;
    else status = Number(current?.amount) > 0
      ? `${replacement.name} will be used instead · ${quantity(Number(current.amount), replacement.unit)} for this service`
      : `${replacement.name} is counted in ${replacement.unit}. Enter how much to use.`;
  }

  return (
    <div className={`addon-item supply-item ${choice !== "default" ? "selected" : ""}`}>
      <div className="addon-info">
        <span className="addon-name-row">
          <span className="addon-name">{line.item.name}</span>
          <span className={choice === "default" ? "supply-badge" : "addon-service-badge"}>{BADGES[choice]}</span>
        </span>
        <span className="addon-stock" id={`${idPrefix}-status`}>{status}</span>
      </div>
      <div className="supply-choice-toggle" role="group" aria-label={`What to use for ${line.item.name}`} aria-describedby={`${idPrefix}-status`}>
        {SUPPLY_CHOICES.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`supply-choice-btn ${choice === option.value ? "active" : ""}`}
            aria-pressed={choice === option.value}
            disabled={option.value === "substitute" && !options.length}
            onClick={() => choose(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {choice === "substitute" && (
        <div className={`supply-replacement-row ${askAmount ? "has-amount" : ""}`}>
          <div className="form-group supply-replacement">
            <label htmlFor={`${idPrefix}-item`}>Item to use instead of {line.item.name} *</label>
            <select
              id={`${idPrefix}-item`}
              className="form-control"
              value={current?.itemId || ""}
              onChange={(event) => updateReplacement({ itemId: event.target.value, amount: "" })}
            >
              <option value="" disabled>Choose an item from inventory</option>
              {sameUnit.length > 0 && (
                <optgroup label={`Counted in ${line.item.unit}: uses the usual amount`}>
                  {sameUnit.map((option) => renderOption(option, Number(option.current_stock) >= needed))}
                </optgroup>
              )}
              {otherUnit.length > 0 && (
                <optgroup label="Counted differently: enter the amount">
                  {otherUnit.map((option) => renderOption(option, Number(option.current_stock) > 0))}
                </optgroup>
              )}
            </select>
          </div>
          {askAmount && (
            <div className="form-group supply-replacement">
              <label htmlFor={`${idPrefix}-amount`}>Amount to use ({replacement.unit}) *</label>
              <input
                id={`${idPrefix}-amount`}
                className="form-control"
                type="number"
                inputMode="decimal"
                min={stockStep(replacement.unit)}
                step={stockStep(replacement.unit)}
                placeholder={`e.g. ${stockStep(replacement.unit) === "1" ? 1 : 50}`}
                value={current?.amount || ""}
                onChange={(event) => updateReplacement({ amount: event.target.value })}
              />
            </div>
          )}
        </div>
      )}
      {!options.length && (
        <span className="form-hint supply-hint">
          &ldquo;Other item&rdquo; needs another item in this branch&apos;s inventory.
        </span>
      )}
    </div>
  );
}
