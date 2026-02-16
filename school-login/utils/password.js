const MIN_PASSWORD_LENGTH = Number(process.env.MIN_PASSWORD_LENGTH) || 10;

function getPasswordValidationError(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`;
  }
  const hasLetter = /[A-Za-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  if (!hasLetter || !hasNumber) {
    return "Passwort muss mindestens einen Buchstaben und eine Zahl enthalten.";
  }
  return null;
}

module.exports = { MIN_PASSWORD_LENGTH, getPasswordValidationError };
