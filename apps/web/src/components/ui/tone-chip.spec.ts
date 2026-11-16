import styles from "./tone-chip.module.css";

it("exposes v6 tone-chip classes on existing tokens", () => {
  expect(styles.orangeTone).toBeTruthy();
  expect(styles.violetTone).toBeTruthy();
  expect(styles.dangerStrongTone).toBeTruthy();
});