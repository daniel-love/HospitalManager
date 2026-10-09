/**
 * Imaging and pathology (GAME_DESIGN §4.4, §5.2). Times are in-game minutes.
 * Real-world anchors: most A&E blood results are back within about an hour
 * of the sample reaching the lab; a CT head report follows the scan within
 * the hour; NICE wants a CT head within an hour for head injuries that need
 * one.
 */

/** The biomedical scientist booking a sample in and loading the analyser. */
export const LAB_PROCESS_MINS: [number, number] = [5, 10];
/** The analyser's run, after which results are on the system. */
export const ANALYSER_MINS: [number, number] = [30, 45];

/** The radiographer's time at the X-ray unit or CT scanner, per patient. */
export const XRAY_MINS: [number, number] = [10, 15];
export const CT_MINS: [number, number] = [15, 25];
/** X-rays are read by the A&E clinician at once; a radiologist reports CT (remotely). */
export const CT_REPORT_MINS: [number, number] = [20, 45];

/** The NICE target for a CT head after a head injury: within an hour of the request. */
export const CT_TARGET_MINS = 60;
