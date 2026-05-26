export function shouldDisableDfuButton({
  isBusy,
  hasFirmware,
  hasProvider,
  firmwareProtocol,
  nordicRowVisible,
  nordicBaseChecked,
  nordicAppChecked,
}) {
  if (isBusy || !hasFirmware || !hasProvider) return true;

  const missingNordicSelection =
    firmwareProtocol === 'nordic' &&
    nordicRowVisible &&
    !nordicBaseChecked &&
    !nordicAppChecked;

  return missingNordicSelection;
}
