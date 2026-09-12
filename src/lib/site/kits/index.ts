/**
 * Kit registry. Every JSON file in this directory is validated by
 * schema.test.ts (`npm run kits:validate`). Gallery order follows
 * QuiltHostingTemplates.md.
 */

import { kitSchema } from "./schema";
import type { Kit } from "./schema";
import heritage from "./heritage.json";
import modernGuild from "./modern-guild.json";
import showFestival from "./show-festival.json";
import artQuilt from "./art-quilt.json";
import communityThreads from "./community-threads.json";
import appliqueBloom from "./applique-bloom.json";
import prairie from "./prairie.json";
import minimal from "./minimal.json";
import onePager from "./one-pager.json";
import longarmStudio from "./longarm-studio.json";
import quiltShop from "./quilt-shop.json";
import patternDesigner from "./pattern-designer.json";
import retreatHouse from "./retreat-house.json";
import virtualGuild from "./virtual-guild.json";
import quiltMuseum from "./quilt-museum.json";
import memoryQuilts from "./memory-quilts.json";
import barnQuiltTrail from "./barn-quilt-trail.json";
import youngStitchers from "./young-stitchers.json";
import stateAssociation from "./state-association.json";
import slowStitchStudio from "./slow-stitch-studio.json";
import marketQuilter from "./market-quilter.json";
import quiltAppraiser from "./quilt-appraiser.json";
import eppCircle from "./epp-circle.json";
import snowbirdGuild from "./snowbird-guild.json";
import scrapCircle from "./scrap-circle.json";
import prayerCircle from "./prayer-circle.json";
import foundationPiecers from "./foundation-piecers.json";
import tshirtMaker from "./tshirt-maker.json";
import restorationAtelier from "./restoration-atelier.json";
import sitDownStudio from "./sit-down-studio.json";
import quiltAlong from "./quilt-along.json";
import bindingBar from "./binding-bar.json";
import ufoClub from "./ufo-club.json";
import handQuilters from "./hand-quilters.json";
import mensCircle from "./mens-circle.json";
import coastalGuild from "./coastal-guild.json";
import mountainGuild from "./mountain-guild.json";
import firstQuilt from "./first-quilt.json";
import reproduction from "./reproduction.json";
import woolCircle from "./wool-circle.json";
import fabricSwap from "./fabric-swap.json";
import nightOwls from "./night-owls.json";
import dyeHouse from "./dye-house.json";
import classBench from "./class-bench.json";
import jerseyQuilts from "./jersey-quilts.json";
import hiredPiecer from "./hired-piecer.json";
import makerHall from "./maker-hall.json";
import vintageYardage from "./vintage-yardage.json";
import quiltLens from "./quilt-lens.json";
import lectureCircuit from "./lecture-circuit.json";
import cribStudio from "./crib-studio.json";
import showCrew from "./show-crew.json";
import quiltDocumentationDays from "./quilt-documentation-days.json";
import quiltFilm from "./quilt-film.json";
import templateWorkshop from "./template-workshop.json";
import quiltTruck from "./quilt-truck.json";
import quiltingAcademy from "./quilting-academy.json";
import quiltAuthor from "./quilt-author.json";
import quiltPhotographer from "./quilt-photographer.json";
import guestbookQuilts from "./guestbook-quilts.json";
import farmBattingCompany from "./farm-batting-company.json";
import quiltFrameMaker from "./quilt-frame-maker.json";
import longarmPantographs from "./longarm-pantographs.json";
import woolAppliqueCircle from "./wool-applique-circle.json";
import quiltCruise from "./quilt-cruise.json";
import sewingMachineHospital from "./sewing-machine-hospital.json";
import silentBee from "./silent-bee.json";
import postageStamp from "./postage-stamp.json";
import curveTable from "./curve-table.json";
import twoColor from "./two-color.json";
import postcardPost from "./postcard-post.json";
import dinerBooth from "./diner-booth.json";
import tessellate from "./tessellate.json";
import coatGuild from "./coat-guild.json";
import mysteryClue from "./mystery-clue.json";
import observatory from "./observatory.json";
import pixelLoft from "./pixel-loft.json";
import atlasQuilt from "./atlas-quilt.json";
import threadRoom from "./thread-room.json";
import dieLab from "./die-lab.json";
import labelLoom from "./label-loom.json";
import kennelQuilt from "./kennel-quilt.json";
import houseBlock from "./house-block.json";
import climateVault from "./climate-vault.json";
import notionsBar from "./notions-bar.json";
import crateRoute from "./crate-route.json";
import vintageLinenStudio from "./vintage-linen-studio.json";
import patternLibrary from "./pattern-library.json";
import neighborhoodBees from "./neighborhood-bees.json";
import healingStitches from "./healing-stitches.json";
import guysWhoQuilt from "./guys-who-quilt.json";
import quiltingFellowship from "./quilting-fellowship.json";

import linenJournal from "./linen-journal.json";
import colorAssembly from "./color-assembly.json";
import indigoHouse from "./indigo-house.json";
import quiltBiennial from "./quilt-biennial.json";
import commonThreadReview from "./common-thread-review.json";
import atelierNoir from "./atelier-noir.json";
import weekendHouse from "./weekend-house.json";

import paperPieces from "./paper-pieces.json";
import blackbirdStudio from "./blackbird-studio.json";
import blueRidgeCircle from "./blue-ridge-circle.json";
import sunroomSociety from "./sunroom-society.json";
import redworkArchive from "./redwork-archive.json";
import quiltShowEdition from "./quilt-show-edition.json";
import mendingCircle from "./mending-circle.json";
import patternHouse from "./pattern-house.json";
import nightBloom from "./night-bloom.json";
import lakeEffect from "./lake-effect.json";
import citrusPress from "./citrus-press.json";
import quiltCamp from "./quilt-camp.json";
import modernHeirloom from "./modern-heirloom.json";
import selvageClub from "./selvage-club.json";
import needleAndPine from "./needle-and-pine.json";
import studioGrid from "./studio-grid.json";
import storyCloth from "./story-cloth.json";
import holidayHouse from "./holiday-house.json";

export type { Kit, KitDefaults, KitImage, KitIssue, KitPage, SiteMenuItem } from "./schema";
export { kitSchema, validateKit, KIT_SYSTEM_PATHS, SAMPLE_MARKER } from "./schema";
export type { KitTenant, KitVars, PageInsert } from "./apply";
export {
  CITY_FALLBACK,
  MEETING_INFO_FALLBACK,
  kitDesign,
  kitPageRows,
  kitSettingsJson,
  sectionsToLegacyBlocks,
  substitutePlaceholders,
} from "./apply";

/** Parsed (typed, section-normalized) kits, in gallery order. */
export const KITS: Kit[] = [
  quiltBiennial,
  commonThreadReview,
  atelierNoir,
  heritage,
  modernGuild,
  showFestival,
  artQuilt,
  communityThreads,
  appliqueBloom,
  prairie,
  minimal,
  onePager,
  longarmStudio,
  quiltShop,
  patternDesigner,
  retreatHouse,
  virtualGuild,
  quiltMuseum,
  memoryQuilts,
  barnQuiltTrail,
  youngStitchers,
  stateAssociation,
  slowStitchStudio,
  marketQuilter,
  quiltAppraiser,
  eppCircle,
  snowbirdGuild,
  scrapCircle,
  prayerCircle,
  foundationPiecers,
  tshirtMaker,
  restorationAtelier,
  sitDownStudio,
  quiltAlong,
  bindingBar,
  ufoClub,
  handQuilters,
  mensCircle,
  coastalGuild,
  mountainGuild,
  firstQuilt,
  reproduction,
  woolCircle,
  fabricSwap,
  nightOwls,
  dyeHouse,
  classBench,
  jerseyQuilts,
  hiredPiecer,
  makerHall,
  vintageYardage,
  quiltLens,
  lectureCircuit,
  cribStudio,
  showCrew,
  quiltDocumentationDays,
  quiltFilm,
  templateWorkshop,
  quiltTruck,
  quiltingAcademy,
  quiltAuthor,
  quiltPhotographer,
  guestbookQuilts,
  farmBattingCompany,
  quiltFrameMaker,
  longarmPantographs,
  woolAppliqueCircle,
  quiltCruise,
  sewingMachineHospital,
  silentBee,
  postageStamp,
  curveTable,
  twoColor,
  postcardPost,
  dinerBooth,
  tessellate,
  coatGuild,
  mysteryClue,
  observatory,
  pixelLoft,
  atlasQuilt,
  threadRoom,
  dieLab,
  labelLoom,
  kennelQuilt,
  houseBlock,
  climateVault,
  notionsBar,
  crateRoute,
  vintageLinenStudio,
  patternLibrary,
  neighborhoodBees,
  healingStitches,
  guysWhoQuilt,
  quiltingFellowship,
  linenJournal,
  colorAssembly,
  indigoHouse,
  weekendHouse,
  paperPieces,
  blackbirdStudio,
  blueRidgeCircle,
  sunroomSociety,
  redworkArchive,
  quiltShowEdition,
  mendingCircle,
  patternHouse,
  nightBloom,
  lakeEffect,
  citrusPress,
  quiltCamp,
  modernHeirloom,
  selvageClub,
  needleAndPine,
  studioGrid,
  storyCloth,
  holidayHouse,
].map((raw) => kitSchema.parse(raw));

const BY_ID = new Map(KITS.map((k) => [k.id, k]));

export function kitById(id: string): Kit | null {
  return BY_ID.get(id) ?? null;
}
