export const WORKER = "https://scoreboard-ivory-xi.vercel.app/api";

export const SPORTS = [
  { label: "NBA",  value: "basketball/nba" },
  { label: "NFL",  value: "football/nfl" },
  { label: "MLB",  value: "baseball/mlb" },
  { label: "NHL",  value: "hockey/nhl" },
];

export const STAT_FULL = {
  points:"points", rebounds:"rebounds", assists:"assists", threePointers:"3-pointers",
  goals:"goals",
  hits:"hits", hrr:"H+R+RBI", strikeouts:"strikeouts",
  passingYards:"passing yards", rushingYards:"rushing yards", receivingYards:"receiving yards", touchdowns:"touchdowns",
};

export const MLB_TEAM = {
  ARI:"Diamondbacks",ATL:"Braves",BAL:"Orioles",BOS:"Red Sox",CHC:"Cubs",CWS:"White Sox",
  CIN:"Reds",CLE:"Guardians",COL:"Rockies",DET:"Tigers",HOU:"Astros",KC:"Royals",
  LAA:"Angels",LAD:"Dodgers",MIA:"Marlins",MIL:"Brewers",MIN:"Twins",NYM:"Mets",
  NYY:"Yankees",OAK:"Athletics",PHI:"Phillies",PIT:"Pirates",SD:"Padres",SEA:"Mariners",
  SF:"Giants",STL:"Cardinals",TB:"Rays",TEX:"Rangers",TOR:"Blue Jays",WSH:"Nationals",
};

// Static team list — all active MLB/NBA/NHL franchises.
// abbr must match the abbreviations used in play data (homeTeam/awayTeam fields).
export const TEAM_DB = [
  // MLB
  {abbr:"ARI",sport:"mlb",name:"Arizona Diamondbacks",short:"Diamondbacks"},
  {abbr:"ATL",sport:"mlb",name:"Atlanta Braves",short:"Braves"},
  {abbr:"BAL",sport:"mlb",name:"Baltimore Orioles",short:"Orioles"},
  {abbr:"BOS",sport:"mlb",name:"Boston Red Sox",short:"Red Sox"},
  {abbr:"CHC",sport:"mlb",name:"Chicago Cubs",short:"Cubs"},
  {abbr:"CWS",sport:"mlb",name:"Chicago White Sox",short:"White Sox"},
  {abbr:"CIN",sport:"mlb",name:"Cincinnati Reds",short:"Reds"},
  {abbr:"CLE",sport:"mlb",name:"Cleveland Guardians",short:"Guardians"},
  {abbr:"COL",sport:"mlb",name:"Colorado Rockies",short:"Rockies"},
  {abbr:"DET",sport:"mlb",name:"Detroit Tigers",short:"Tigers"},
  {abbr:"HOU",sport:"mlb",name:"Houston Astros",short:"Astros"},
  {abbr:"KC",sport:"mlb",name:"Kansas City Royals",short:"Royals"},
  {abbr:"LAA",sport:"mlb",name:"Los Angeles Angels",short:"Angels"},
  {abbr:"LAD",sport:"mlb",name:"Los Angeles Dodgers",short:"Dodgers"},
  {abbr:"MIA",sport:"mlb",name:"Miami Marlins",short:"Marlins"},
  {abbr:"MIL",sport:"mlb",name:"Milwaukee Brewers",short:"Brewers"},
  {abbr:"MIN",sport:"mlb",name:"Minnesota Twins",short:"Twins"},
  {abbr:"NYM",sport:"mlb",name:"New York Mets",short:"Mets"},
  {abbr:"NYY",sport:"mlb",name:"New York Yankees",short:"Yankees"},
  {abbr:"OAK",sport:"mlb",name:"Oakland Athletics",short:"Athletics"},
  {abbr:"PHI",sport:"mlb",name:"Philadelphia Phillies",short:"Phillies"},
  {abbr:"PIT",sport:"mlb",name:"Pittsburgh Pirates",short:"Pirates"},
  {abbr:"SD",sport:"mlb",name:"San Diego Padres",short:"Padres"},
  {abbr:"SEA",sport:"mlb",name:"Seattle Mariners",short:"Mariners"},
  {abbr:"SF",sport:"mlb",name:"San Francisco Giants",short:"Giants"},
  {abbr:"STL",sport:"mlb",name:"St. Louis Cardinals",short:"Cardinals"},
  {abbr:"TB",sport:"mlb",name:"Tampa Bay Rays",short:"Rays"},
  {abbr:"TEX",sport:"mlb",name:"Texas Rangers",short:"Rangers"},
  {abbr:"TOR",sport:"mlb",name:"Toronto Blue Jays",short:"Blue Jays"},
  {abbr:"WSH",sport:"mlb",name:"Washington Nationals",short:"Nationals"},
  // NBA
  {abbr:"ATL",sport:"nba",name:"Atlanta Hawks",short:"Hawks"},
  {abbr:"BOS",sport:"nba",name:"Boston Celtics",short:"Celtics"},
  {abbr:"BKN",sport:"nba",name:"Brooklyn Nets",short:"Nets"},
  {abbr:"CHA",sport:"nba",name:"Charlotte Hornets",short:"Hornets"},
  {abbr:"CHI",sport:"nba",name:"Chicago Bulls",short:"Bulls"},
  {abbr:"CLE",sport:"nba",name:"Cleveland Cavaliers",short:"Cavaliers"},
  {abbr:"DAL",sport:"nba",name:"Dallas Mavericks",short:"Mavericks"},
  {abbr:"DEN",sport:"nba",name:"Denver Nuggets",short:"Nuggets"},
  {abbr:"DET",sport:"nba",name:"Detroit Pistons",short:"Pistons"},
  {abbr:"GSW",sport:"nba",name:"Golden State Warriors",short:"Warriors"},
  {abbr:"HOU",sport:"nba",name:"Houston Rockets",short:"Rockets"},
  {abbr:"IND",sport:"nba",name:"Indiana Pacers",short:"Pacers"},
  {abbr:"LAC",sport:"nba",name:"LA Clippers",short:"Clippers"},
  {abbr:"LAL",sport:"nba",name:"Los Angeles Lakers",short:"Lakers"},
  {abbr:"MEM",sport:"nba",name:"Memphis Grizzlies",short:"Grizzlies"},
  {abbr:"MIA",sport:"nba",name:"Miami Heat",short:"Heat"},
  {abbr:"MIL",sport:"nba",name:"Milwaukee Bucks",short:"Bucks"},
  {abbr:"MIN",sport:"nba",name:"Minnesota Timberwolves",short:"Timberwolves"},
  {abbr:"NOP",sport:"nba",name:"New Orleans Pelicans",short:"Pelicans"},
  {abbr:"NYK",sport:"nba",name:"New York Knicks",short:"Knicks"},
  {abbr:"OKC",sport:"nba",name:"Oklahoma City Thunder",short:"Thunder"},
  {abbr:"ORL",sport:"nba",name:"Orlando Magic",short:"Magic"},
  {abbr:"PHI",sport:"nba",name:"Philadelphia 76ers",short:"76ers"},
  {abbr:"PHX",sport:"nba",name:"Phoenix Suns",short:"Suns"},
  {abbr:"POR",sport:"nba",name:"Portland Trail Blazers",short:"Trail Blazers"},
  {abbr:"SAC",sport:"nba",name:"Sacramento Kings",short:"Kings"},
  {abbr:"SAS",sport:"nba",name:"San Antonio Spurs",short:"Spurs"},
  {abbr:"TOR",sport:"nba",name:"Toronto Raptors",short:"Raptors"},
  {abbr:"UTA",sport:"nba",name:"Utah Jazz",short:"Jazz"},
  {abbr:"WAS",sport:"nba",name:"Washington Wizards",short:"Wizards"},
  // NHL
  {abbr:"ANA",sport:"nhl",name:"Anaheim Ducks",short:"Ducks"},
  {abbr:"BOS",sport:"nhl",name:"Boston Bruins",short:"Bruins"},
  {abbr:"BUF",sport:"nhl",name:"Buffalo Sabres",short:"Sabres"},
  {abbr:"CGY",sport:"nhl",name:"Calgary Flames",short:"Flames"},
  {abbr:"CAR",sport:"nhl",name:"Carolina Hurricanes",short:"Hurricanes"},
  {abbr:"CHI",sport:"nhl",name:"Chicago Blackhawks",short:"Blackhawks"},
  {abbr:"COL",sport:"nhl",name:"Colorado Avalanche",short:"Avalanche"},
  {abbr:"CBJ",sport:"nhl",name:"Columbus Blue Jackets",short:"Blue Jackets"},
  {abbr:"DAL",sport:"nhl",name:"Dallas Stars",short:"Stars"},
  {abbr:"DET",sport:"nhl",name:"Detroit Red Wings",short:"Red Wings"},
  {abbr:"EDM",sport:"nhl",name:"Edmonton Oilers",short:"Oilers"},
  {abbr:"FLA",sport:"nhl",name:"Florida Panthers",short:"Panthers"},
  {abbr:"LAK",sport:"nhl",name:"Los Angeles Kings",short:"Kings"},
  {abbr:"MIN",sport:"nhl",name:"Minnesota Wild",short:"Wild"},
  {abbr:"MTL",sport:"nhl",name:"Montreal Canadiens",short:"Canadiens"},
  {abbr:"NSH",sport:"nhl",name:"Nashville Predators",short:"Predators"},
  {abbr:"NJD",sport:"nhl",name:"New Jersey Devils",short:"Devils"},
  {abbr:"NYI",sport:"nhl",name:"New York Islanders",short:"Islanders"},
  {abbr:"NYR",sport:"nhl",name:"New York Rangers",short:"Rangers"},
  {abbr:"OTT",sport:"nhl",name:"Ottawa Senators",short:"Senators"},
  {abbr:"PHI",sport:"nhl",name:"Philadelphia Flyers",short:"Flyers"},
  {abbr:"PIT",sport:"nhl",name:"Pittsburgh Penguins",short:"Penguins"},
  {abbr:"SEA",sport:"nhl",name:"Seattle Kraken",short:"Kraken"},
  {abbr:"SJS",sport:"nhl",name:"San Jose Sharks",short:"Sharks"},
  {abbr:"STL",sport:"nhl",name:"St. Louis Blues",short:"Blues"},
  {abbr:"TBL",sport:"nhl",name:"Tampa Bay Lightning",short:"Lightning"},
  {abbr:"TOR",sport:"nhl",name:"Toronto Maple Leafs",short:"Maple Leafs"},
  {abbr:"VAN",sport:"nhl",name:"Vancouver Canucks",short:"Canucks"},
  {abbr:"VGK",sport:"nhl",name:"Vegas Golden Knights",short:"Golden Knights"},
  {abbr:"WAS",sport:"nhl",name:"Washington Capitals",short:"Capitals"},
  {abbr:"WPG",sport:"nhl",name:"Winnipeg Jets",short:"Jets"},
];

export const TOTAL_THRESHOLDS = {
  mlb: [5,6,7,8,9,10,11],
  nba: [200,210,215,220,225,230,235,240,250],
  nhl: [3,4,5,6,7,8],
};

export const TEAM_TOTAL_THRESHOLDS = {
  mlb: [2,3,4,5,6,7,8],
  nba: [100,105,110,115,120,125,130],
};

export const STAT_LABEL = {
  points:"PTS", rebounds:"REB", assists:"AST", threePointers:"3PT",
  goals:"G", shotsOnGoal:"SOG",
  hits:"H", hrr:"HRR", strikeouts:"K",
  passingYards:"PASS YDS", rushingYards:"RUSH YDS", receivingYards:"REC YDS", touchdowns:"TD",
};

export const SPORT_KEY = { nba:"basketball/nba", nfl:"football/nfl", nhl:"hockey/nhl", mlb:"baseball/mlb" };



export const SPORT_BADGE_COLOR = { nba:"#58a6ff", nhl:"#a5d8ff", mlb:"#3fb950", nfl:"#f78166" };

export const GAMELOG_COLS = {
  "baseball/mlb_pitcher": [
    { key:"date",        label:"Date", tooltip:"Game date",                                           align:"left"   },
    { key:"isHome",      label:"H/A",  tooltip:"Home (blank) or away (@)",                           align:"center" },
    { key:"oppAbbr",     label:"Opp",  tooltip:"Opponent",                                           align:"left"   },
    { key:"ip",          label:"IP",   tooltip:"Innings pitched"                                                     },
    { key:"hitsAllowed", label:"H",    tooltip:"Hits allowed"                                                        },
    { key:"er",          label:"ER",   tooltip:"Earned runs allowed"                                                 },
    { key:"bb",          label:"BB",   tooltip:"Walks — component of K-BB% SimScore gate"                           },
    { key:"strikeouts",  label:"K",    tooltip:"Strikeouts — drives CSW%/K% and K-BB% SimScore"                     },
    { key:"pc",          label:"PC",   tooltip:"Pitch count — feeds avg pitches/start SimScore gate"                 },
  ],
  "baseball/mlb_hitter": [
    { key:"date",      label:"Date", tooltip:"Game date",                                  align:"left"   },
    { key:"isHome",    label:"H/A",  tooltip:"Home (blank) or away (@)",                  align:"center" },
    { key:"oppAbbr",   label:"Opp",  tooltip:"Opponent",                                  align:"left"   },
    { key:"ab",        label:"AB",   tooltip:"At-bats"                                                   },
    { key:"hits",      label:"H",    tooltip:"Hits"                                                      },
    { key:"homeRuns",  label:"HR",   tooltip:"Home runs"                                                 },
    { key:"r",         label:"R",    tooltip:"Runs scored — component of H+R+RBI"                       },
    { key:"rbi",       label:"RBI",  tooltip:"Runs batted in — component of H+R+RBI"                    },
    { key:"bb",        label:"BB",   tooltip:"Walks"                                                     },
    { key:"hrr",       label:"HRR",  tooltip:"Hits + Runs + RBIs combined (Kalshi stat)"                },
  ],
  "basketball/nba": [
    { key:"date",          label:"Date", tooltip:"Game date",                                                    align:"left"   },
    { key:"isHome",        label:"H/A",  tooltip:"Home (blank) or away (@)",                                    align:"center" },
    { key:"oppAbbr",       label:"Opp",  tooltip:"Opponent",                                                    align:"left"   },
    { key:"points",        label:"PTS",  tooltip:"Points scored"                                                               },
    { key:"rebounds",      label:"REB",  tooltip:"Rebounds"                                                                    },
    { key:"assists",       label:"AST",  tooltip:"Assists"                                                                     },
    { key:"threePointers", label:"3P",   tooltip:"Three-pointers made"                                                         },
    { key:"min",           label:"MIN",  tooltip:"Minutes played (display only — not a SimScore component)"                   },
    { key:"rest",          label:"Rest", tooltip:"Days since last game — 1 = back-to-back (reduces simulation mean by 7%)"    },
  ],
  "hockey/nhl": [
    { key:"date",    label:"Date", tooltip:"Game date",                                                       align:"left"   },
    { key:"isHome",  label:"H/A",  tooltip:"Home (blank) or away (@)",                                       align:"center" },
    { key:"oppAbbr", label:"Opp",  tooltip:"Opponent",                                                       align:"left"   },
    { key:"g",       label:"G",    tooltip:"Goals"                                                                           },
    { key:"a",       label:"A",    tooltip:"Assists"                                                                         },
    { key:"points",  label:"PTS",  tooltip:"Points (goals + assists)"                                                        },
    { key:"toi",     label:"TOI",  tooltip:"Time on ice — ≥18 min = 2 SimScore pts, ≥15 min = 1 pt, <15 min = 0 pts"       },
    { key:"rest",    label:"Rest", tooltip:"Days since last game — 1 = back-to-back (reduces simulation mean by 7%)"         },
  ],
  "football/nfl": [
    { key:"date",           label:"Date",   tooltip:"Game date",       align:"left"   },
    { key:"isHome",         label:"H/A",    tooltip:"Home (blank) or away (@)", align:"center" },
    { key:"oppAbbr",        label:"Opp",    tooltip:"Opponent",        align:"left"   },
    { key:"completions",    label:"CMP",    tooltip:"Completions"                     },
    { key:"attempts",       label:"ATT",    tooltip:"Pass attempts"                   },
    { key:"passingYards",   label:"PYds",   tooltip:"Passing yards"                   },
    { key:"rushingYards",   label:"RYds",   tooltip:"Rushing yards"                   },
    { key:"receptions",     label:"REC",    tooltip:"Receptions"                      },
    { key:"receivingYards", label:"RecYds", tooltip:"Receiving yards"                 },
  ],
};
