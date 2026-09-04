use crate::random;
use crate::record::{Tier, Record};
use crate::genetic::NeuralNetwork;
use crate::simulation::{Bet, Simulator, Strategy, lookup, SALT_MINE_AMOUNT, TOURNAMENT_BALANCE, NUMBER_OF_BOTS};


//const MATCHMAKING_STRATEGY: RandomStrategy = RandomStrategy::Left;

pub const MATCHMAKING_STRATEGY: CustomStrategy = CustomStrategy {
    average_sums: false,
    round_to_magnitude: false,
    scale_by_matches: true,
    scale_by_money: true,
    scale_by_time: None,
    money: MoneyStrategy::Matchmaking { max_bet: FIXED_BET_AMOUNT },
    bet: BetStrategy::Matchmaking,
};

pub fn matchmaking_strategy(max_bet: f64) -> CustomStrategy {
    CustomStrategy {
        average_sums: false,
        round_to_magnitude: false,
        scale_by_matches: true,
        scale_by_money: true,
        scale_by_time: None,
        money: MoneyStrategy::Matchmaking { max_bet },
        bet: BetStrategy::Matchmaking,
    }
}

/*const MATCHMAKING_STRATEGY: EarningsStrategy = EarningsStrategy {
    expected_profit: true,
    winrate: false,
    bet_difference: false,
    winrate_difference: false,
    use_percentages: true,
};*/

pub const TOURNAMENT_STRATEGY: CustomStrategy = CustomStrategy {
    average_sums: false,
    round_to_magnitude: false,
    scale_by_matches: false,
    scale_by_money: false,
    scale_by_time: None,
    money: MoneyStrategy::Tournament,
    bet: BetStrategy::Elo,
};


/*lazy_static! {
    pub static ref GENETIC_STRATEGY: Box<NeuralNetwork> = {
        let result: FitnessResult<CustomStrategy> = serde_json::from_str(&include_str!("../../strategies/2019-07-30T11.20.23 0 (matchmaking)")).unwrap();
        Box::new(result.creature.bet.unwrap_genetic().clone())
    };
}*/


pub trait Permutate {
    fn each<F>(f: F) where F: FnMut(Self), Self: Sized;
}

impl Permutate for bool {
    fn each<F>(mut f: F) where F: FnMut(Self) {
        f(true);
        f(false);
    }
}


pub const PERCENTAGE_THRESHOLD: f64 = SALT_MINE_AMOUNT * 100.0;
pub const FIXED_BET_AMOUNT: f64 = 32_000.0;
const MINIMUM_MATCHES_MATCHMAKING: f64 = 5.0;   // minimum match data before it starts betting
const MAXIMUM_MATCHES_MATCHMAKING: f64 = 50.0;  // maximum match data before it reaches the MAXIMUM_BET_PERCENTAGE
const MAXIMUM_WEIGHT: f64 = 10.0;               // maximum percentage for the weight
const MAXIMUM_BET_PERCENTAGE: f64 = 0.015;      // maximum percentage that it will bet (of current money)
//const MINIMUM_BET_AMOUNT: f64 = 50_000.0;       // minimum amount before it will bet
//const MAXIMUM_BET_AMOUNT: f64 = 350000.0;       // maximum amount it will bet
const MINIMUM_WINRATE: f64 = 0.10;              // minimum winrate difference before it will bet


const MAGNITUDE: f64 = 5.0;

// TODO is this optimal ?
// TODO use something like round instead ?
// TODO handle negative numbers correctly (https://stackoverflow.com/a/9204760/449477)
fn round_to_order_of_magnitude(input: f64) -> f64 {
    if MAGNITUDE == 2.0 {
        MAGNITUDE.powf(input.log2().trunc())

    } else if MAGNITUDE == 10.0 {
        MAGNITUDE.powf(input.log10().trunc())

    } else {
        MAGNITUDE.powf(input.log(MAGNITUDE).trunc())
    }
}

fn assert_not_nan(x: f64) {
    assert!(!x.is_nan());
}

fn weight_percentage(len: f64, max: f64) -> f64 {
    (len / max).max(0.0).min(1.0)
}

fn weight(_percentage: f64, general: f64, _specific: f64) -> f64 {
    general

    /*
    // TODO is this correct ?
    let general = if percentage == 1.0 {
        0.0
    } else {
        general * (1.0 - percentage)
    };

    // TODO is this correct ?
    let specific = if percentage == 0.0 {
        0.0
    } else {
        specific * percentage
    };

    general + specific*/
}

pub fn normalize(value: f64, min: f64, max: f64) -> f64 {
    // TODO is this correct ?
    if min == max {
        0.0

    } else {
        ((value - min) * (1.0 / (max - min))).max(0.0).min(1.0)
    }
}

#[inline]
fn range_inclusive(percentage: f64, low: f64, high: f64) -> f64 {
    low + (percentage * (high - low))
}

fn weighted<A, F>(simulation: &A, left: &str, right: &str, tier: Tier, left_bet: f64, right_bet: f64, mut f: F) -> (f64, f64)
    where A: Simulator,
          F: FnMut(Vec<&Record>, &str, f64) -> f64 {

    let left_general = f(simulation.lookup_character(left, tier), left, left_bet);
    let right_general = f(simulation.lookup_character(right, tier), right, right_bet);

    let specific_matches = simulation.lookup_specific_character(left, right, tier);
    // TODO this f64 conversions is a bit gross
    let specific_matches_percentage = weight_percentage(specific_matches.len() as f64, MAXIMUM_WEIGHT);

    // TODO gross, figure out how to avoid the clone
    let left_specific = f(specific_matches.clone(), left, left_bet);
    let right_specific = f(specific_matches, right, right_bet);

    // Scales it so that as it collects more matchup-specific data it favors the matchup-specific data more
    (
        weight(specific_matches_percentage, left_general, left_specific),
        weight(specific_matches_percentage, right_general, right_specific),
    )
}

pub fn winrates<A>(simulation: &A, left: &str, right: &str, tier: Tier) -> (f64, f64) where A: Simulator {
    weighted(simulation, left, right, tier, 0.0, 0.0, |records, name, _bet| lookup::wins(records, name))
}

pub fn average_odds<A>(simulation: &A, left: &str, right: &str, tier: Tier, left_bet: f64, right_bet: f64) -> (f64, f64) where A: Simulator {
    weighted(simulation, left, right, tier, left_bet, right_bet, |records, name, bet| lookup::odds(records.into_iter(), name, bet * NUMBER_OF_BOTS))
}

pub fn needed_odds<A>(simulation: &A, left: &str, right: &str, tier: Tier) -> (f64, f64) where A: Simulator {
    weighted(simulation, left, right, tier, 0.0, 0.0, |records, name, _bet| lookup::needed_odds(&records, name))
}

pub fn expected_profits<A>(simulation: &A, left: &str, right: &str, tier: Tier, left_bet: f64, right_bet: f64) -> (f64, f64) where A: Simulator {
    weighted(simulation, left, right, tier, left_bet, right_bet, |records, name, bet| lookup::earnings(records, name, bet * NUMBER_OF_BOTS))
}

pub fn bettors<A>(simulation: &A, left: &str, right: &str, tier: Tier) -> (f64, f64) where A: Simulator {
    weighted(simulation, left, right, tier, 0.0, 0.0, |records, name, _bet| lookup::bettors(records, name))
}


pub fn expected_glicko_outcome(left: &glicko2::GlickoRating, right: &glicko2::GlickoRating) -> f64 {
    fn g(rd: f64) -> f64 {
        use std::f64::consts::PI;
        let q = 10.0f64.ln() / 400.0;
        (1.0 + (3.0 * (q * q)) * (rd * rd) / (PI * PI)).sqrt().recip()
    }

    let ld = left.deviation * left.deviation;
    let rd = right.deviation * right.deviation;
    (1.0 + 10.0f64.powf(-(g((ld + rd).sqrt()) * ((left.value - right.value) / 400.0)))).recip()
}


#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum MoneyStrategy {
    ExpectedBetWinner,
    ExpectedBet,
    BetDifference,
    BetDifferenceWinner,
    Percentage,
    Fixed(f64),
    AllIn,
    Tournament,
    UpsetsElo { max_bet: f64 },
    Matchmaking { max_bet: f64 },
}

impl Permutate for MoneyStrategy {
    fn each<F>(mut f: F) where F: FnMut(Self) {
        f(MoneyStrategy::ExpectedBetWinner);
        f(MoneyStrategy::ExpectedBet);
        f(MoneyStrategy::BetDifference);
        f(MoneyStrategy::BetDifferenceWinner);
        f(MoneyStrategy::Percentage);
        f(MoneyStrategy::Fixed(FIXED_BET_AMOUNT));
        f(MoneyStrategy::AllIn);
        f(MoneyStrategy::Tournament);
        f(MoneyStrategy::UpsetsElo { max_bet: FIXED_BET_AMOUNT });
        f(MoneyStrategy::Matchmaking { max_bet: FIXED_BET_AMOUNT });
    }
}

impl MoneyStrategy {
    fn current_money<A: Simulator>(simulation: &A, average_sums: bool) -> f64 {
        let current_money = simulation.current_money();

        if average_sums {
            let average = simulation.average_sum();

            if average > current_money {
                current_money

            } else {
                average
            }

        } else {
            current_money
        }
    }

    fn bet_percentage(current_money: f64) -> f64 {
        current_money * MAXIMUM_BET_PERCENTAGE
    }

    fn bet_amount<A: Simulator>(&self, simulation: &A, left: &str, right: &str, tier: Tier, average_sums: bool) -> (f64, f64) {
        let current_money = Self::current_money(simulation, average_sums);
        let percentage = Self::bet_percentage(current_money);

        match self {
            MoneyStrategy::ExpectedBetWinner => weighted(simulation, left, right, tier, percentage, percentage, |records, name, bet| simulation.clamp(lookup::expected_bet_winner(&records, name, bet))),
            MoneyStrategy::ExpectedBet => weighted(simulation, left, right, tier, percentage, percentage, |records, name, bet| simulation.clamp(lookup::expected_bet(&records, name, bet))),
            MoneyStrategy::BetDifference => weighted(simulation, left, right, tier, percentage, percentage, |records, name, bet| simulation.clamp(lookup::bet(records, name, bet))),
            MoneyStrategy::BetDifferenceWinner => weighted(simulation, left, right, tier, percentage, percentage, |records, name, bet| simulation.clamp(lookup::winner_bet(records, name, bet))),
            MoneyStrategy::Percentage => (percentage, percentage),
            MoneyStrategy::Fixed(x) => (*x, *x),
            MoneyStrategy::AllIn => (current_money, current_money),
            MoneyStrategy::Tournament => {
                /*let left = simulation.elo(left, tier).wins;
                let right = simulation.elo(right, tier).wins;

                let left_winrate = expected_glicko_outcome(&left.into(), &right.into());
                let right_winrate = 1.0 - left_winrate;

                left_winrate / right_winrate

                TOURNAMENT_BALANCE

                if expected > 0.5 {
                    (1.0, 0.0)

                } else if expected < 0.5 {
                    (0.0, 1.0)

                } else {
                    (0.0, 0.0)
                }*/

                let bet = range_inclusive(normalize(current_money, 100_000.0, 60_000.0), 1.0 / 4.0, 1.0) * current_money;
                (bet, bet)
            },
            MoneyStrategy::UpsetsElo { max_bet } => {
                let left = simulation.elo(left, tier).upsets;
                let right = simulation.elo(right, tier).upsets;
                let amount = normalize((left.value - right.value).abs(), 0.0, 1.0) * max_bet;
                (amount, amount)
            },
            MoneyStrategy::Matchmaking { max_bet } => {
                let left = simulation.elo(left, tier).upsets;
                let right = simulation.elo(right, tier).upsets;

                let expected = expected_glicko_outcome(&left.into(), &right.into());

                let left = expected;
                let right = 1.0 - expected;

                (normalize(left, 0.40, 1.0) * max_bet, normalize(right, 0.40, 1.0) * max_bet)
            },
        }
    }
}


#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum BetStrategy {
    ExpectedBetWinner,
    ExpectedBet,
    ExpectedProfit,
    BetDifference,
    BetDifferenceWinner,
    Odds,
    OddsDifference,
    WinnerOdds,
    Upsets,
    Bettors,
    BettorsRatio,
    IlluminatiBettors,
    NormalBettors,
    BetAmount,
    BetPercentage,
    Wins,
    Losses,
    Left,
    Right,
    Random,
    Elo,
    UpsetsElo,
    Matchmaking,
    Tournament,
    Money,
    Genetic(Box<NeuralNetwork>),
}

impl Permutate for BetStrategy {
    fn each<F>(mut f: F) where F: FnMut(Self) {
        f(BetStrategy::ExpectedBetWinner);
        f(BetStrategy::ExpectedBet);
        f(BetStrategy::ExpectedProfit);
        f(BetStrategy::BetDifference);
        f(BetStrategy::BetDifferenceWinner);
        f(BetStrategy::Odds);
        f(BetStrategy::OddsDifference);
        f(BetStrategy::WinnerOdds);
        f(BetStrategy::Upsets);
        f(BetStrategy::Bettors);
        f(BetStrategy::BettorsRatio);
        f(BetStrategy::IlluminatiBettors);
        f(BetStrategy::NormalBettors);
        f(BetStrategy::BetAmount);
        f(BetStrategy::BetPercentage);
        f(BetStrategy::Wins);
        f(BetStrategy::Losses);
        //f(BetStrategy::Left);
        //f(BetStrategy::Right);
        f(BetStrategy::Elo);
        f(BetStrategy::UpsetsElo);
        f(BetStrategy::Matchmaking);
        f(BetStrategy::Tournament);
        f(BetStrategy::Money);
        //f(BetStrategy::Random);
        //f(BetStrategy::Genetic(GENETIC_STRATEGY.clone()));
    }
}

impl BetStrategy {
    fn bet_value<A: Simulator>(&self, simulation: &A, tier: &Tier, left: &str, right: &str, left_bet: f64, right_bet: f64, _date: f64, average_sums: bool) -> (f64, f64) {
        let current_money = MoneyStrategy::current_money(simulation, average_sums);
        let percentage = MoneyStrategy::bet_percentage(current_money);

        match self {
            BetStrategy::ExpectedBetWinner => weighted(simulation, left, right, *tier, percentage, percentage, |records, name, bet| lookup::expected_bet_winner(&records, name, bet)),
            BetStrategy::ExpectedBet => weighted(simulation, left, right, *tier, percentage, percentage, |records, name, bet| lookup::expected_bet(&records, name, bet)),
            BetStrategy::ExpectedProfit => expected_profits(simulation, left, right, *tier, left_bet, right_bet),
            BetStrategy::BetDifference => weighted(simulation, left, right, *tier, left_bet, right_bet, |records, name, bet| lookup::bet(records, name, bet)),
            BetStrategy::BetDifferenceWinner => weighted(simulation, left, right, *tier, left_bet, right_bet, |records, name, bet| lookup::winner_bet(records, name, bet)),
            BetStrategy::Odds => average_odds(simulation, left, right, *tier, left_bet, right_bet),
            BetStrategy::OddsDifference => weighted(simulation, left, right, *tier, left_bet, right_bet, |records, name, bet| lookup::odds_difference(&records, name, bet * NUMBER_OF_BOTS)),
            BetStrategy::WinnerOdds => weighted(simulation, left, right, *tier, left_bet, right_bet, |records, name, bet| lookup::winner_odds(records, name, bet * NUMBER_OF_BOTS)),
            BetStrategy::Upsets => weighted(simulation, left, right, *tier, left_bet, right_bet, |records, name, bet| lookup::upsets(records, name, bet * NUMBER_OF_BOTS)),
            BetStrategy::Bettors => bettors(simulation, left, right, *tier),
            BetStrategy::BettorsRatio => weighted(simulation, left, right, *tier, 0.0, 0.0, |records, name, _bet| lookup::bettors_ratio(records, name)),
            BetStrategy::IlluminatiBettors => weighted(simulation, left, right, *tier, left_bet, right_bet, |records, name, _bet| lookup::illuminati_bettors(records, name)),
            BetStrategy::NormalBettors => weighted(simulation, left, right, *tier, left_bet, right_bet, |records, name, _bet| lookup::normal_bettors(records, name)),
            BetStrategy::BetAmount => weighted(simulation, left, right, *tier, left_bet, right_bet, |records, name, _bet| lookup::bet_amount(records, name)),
            BetStrategy::BetPercentage => weighted(simulation, left, right, *tier, left_bet, right_bet, |records, name, bet| lookup::bet_percentage(records, name, bet * NUMBER_OF_BOTS)),
            BetStrategy::Wins => winrates(simulation, left, right, *tier),
            BetStrategy::Losses => weighted(simulation, left, right, *tier, left_bet, right_bet, |records, name, _bet| lookup::losses(records, name)),
            BetStrategy::Left => (1.0, 0.0),
            BetStrategy::Right => (0.0, 1.0),
            BetStrategy::Random => if random::bool() {
                (1.0, 0.0)
            } else {
                (0.0, 1.0)
            },
            BetStrategy::Money => (left_bet, right_bet),
            BetStrategy::Elo => {
                let left = simulation.elo(left, *tier).wins;
                let right = simulation.elo(right, *tier).wins;

                //(left.value, right.value)

                let diff = (left.value - right.value).abs();
                let deviation = 0.01; // left.deviation + right.deviation;

                if diff >= deviation {
                    if left.value > right.value {
                        (1.0, 0.0)

                    } else if right.value > left.value {
                        (0.0, 1.0)

                    } else {
                        (0.0, 0.0)
                    }
                } else {
                    (0.0, 0.0)
                }
            },
            BetStrategy::UpsetsElo => {
                let left_win = simulation.elo(left, *tier).wins.value;
                let right_win = simulation.elo(right, *tier).wins.value;

                /*{
                    let x: glicko2::GlickoRating = simulation.elo(left).upsets.into();
                    let y: glicko2::GlickoRating = simulation.elo(right).upsets.into();
                    // (simulation.elo(left).upsets.value - simulation.elo(right).upsets.value).abs()
                    console!(log, x.value, y.value, x.deviation, y.deviation, simulation.elo(left).upsets.value, simulation.elo(left).upsets.deviation);
                }*/

                let left = simulation.elo(left, *tier).upsets;
                let right = simulation.elo(right, *tier).upsets;

                //(left.value, right.value)

                // If the other player has ~260 more win ELO, don't bet
                if left.value > right.value && right_win < left_win + 1.3 {
                    (1.0, 0.0)

                // If the other player has ~260 more win ELO, don't bet
                } else if right.value > left.value && left_win < right_win + 1.3 {
                    (0.0, 1.0)

                } else {
                    (0.0, 0.0)
                }
            },
            BetStrategy::Matchmaking => {
                let left_win = simulation.elo(left, *tier).wins.value;
                let right_win = simulation.elo(right, *tier).wins.value;

                /*{
                    let x: glicko2::GlickoRating = simulation.elo(left).upsets.into();
                    let y: glicko2::GlickoRating = simulation.elo(right).upsets.into();
                    // (simulation.elo(left).upsets.value - simulation.elo(right).upsets.value).abs()
                    console!(log, x.value, y.value, x.deviation, y.deviation, simulation.elo(left).upsets.value, simulation.elo(left).upsets.deviation);
                }*/

                let left = simulation.elo(left, *tier).upsets;
                let right = simulation.elo(right, *tier).upsets;

                let diff_upsets = (left.value - right.value).abs();
                let diff_wins = (left_win - right_win).abs();

                // If the win difference is significantly bigger than the upsets difference
                if diff_wins > diff_upsets + 0.8 {
                    if diff_wins > 0.005 {
                        (left_win, right_win)

                    } else {
                        (0.0, 0.0)
                    }

                    /*
                    // If the other player has ~260 more win ELO, don't bet
                    if left.value > right.value && right_win < left_win + 1.3 {
                        (1.0, 0.0)

                    // If the other player has ~260 more win ELO, don't bet
                    } else if right.value > left.value && left_win < right_win + 1.3 {
                        (0.0, 1.0)

                    } else {
                        (0.0, 0.0)
                    }*/

                } else {
                    if diff_upsets > 0.005 {
                        (left.value, right.value)

                    } else {
                        (0.0, 0.0)
                    }
                }

                //(left.value, right.value)
            },
            BetStrategy::Tournament => {
                let left = simulation.elo(left, *tier).wins;
                let right = simulation.elo(right, *tier).wins;

                let expected = expected_glicko_outcome(&left.into(), &right.into());

                if expected > 0.5 {
                    (1.0, 0.0)

                } else if expected < 0.5 {
                    (0.0, 1.0)

                } else {
                    (0.0, 0.0)
                }

                /*let (left_winrate, right_winrate) = winrates(simulation, left, right, *tier);

                assert_not_nan(left_winrate);
                assert_not_nan(right_winrate);

                let diff = (left_winrate - right_winrate).abs();

                if !simulation.is_in_mines() && diff < MINIMUM_WINRATE {
                    return (0.0, 0.0);
                }

                if left_winrate > right_winrate {
                    (1.0, 0.0)

                } else if right_winrate > left_winrate {
                    (0.0, 1.0)

                } else {
                    (0.0, 0.0)
                }*/
            },
            BetStrategy::Genetic(strategy) => {
                let (left, right) = strategy.choose(simulation, tier, left, right, left_bet, right_bet);

                assert!(left >= 0.0 && left <= 1.0);
                assert!(right >= 0.0 && right <= 1.0);

                if left >= 0.5 || right >= 0.5 {
                    (left, right)

                // Don't bet if left and right are less than 0.5
                } else {
                    (0.0, 0.0)
                }
            },
        }
    }

    pub fn unwrap_genetic(&self) -> &NeuralNetwork {
        match self {
            BetStrategy::Genetic(strategy) => strategy,
            _ => unreachable!(),
        }
    }
}


#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CustomStrategy {
    pub average_sums: bool,
    pub scale_by_matches: bool,
    pub round_to_magnitude: bool,
    pub scale_by_money: bool,
    pub scale_by_time: Option<f64>,
    pub money: MoneyStrategy,
    pub bet: BetStrategy,
}

impl CustomStrategy {
    fn apply_matchmaking_maximum(&self, bet_amount: f64) -> f64 {
        match self.money {
            MoneyStrategy::Matchmaking { max_bet } => bet_amount.min(max_bet),
            _ => bet_amount,
        }
    }

    fn modify_bet_amount<A: Simulator>(&self, simulation: &A, left: &str, right: &str, tier: Tier, date: f64, bet_amount: f64) -> f64 {
        let current_money = simulation.current_money();

        if simulation.is_in_mines() {
            current_money

        } else {
            // Bet high when at low money, to try and get out of mines faster
            // When at low money, bet high. When at high money, bet at most MAXIMUM_BET_PERCENTAGE of current money
            // TODO maybe tweak this
            let bet_amount = if self.scale_by_money && current_money < PERCENTAGE_THRESHOLD {
                let recovery_amount = current_money * (SALT_MINE_AMOUNT / current_money).min(1.0).max(MAXIMUM_BET_PERCENTAGE);
                return self.apply_matchmaking_maximum(recovery_amount);

            } else {
                // TODO verify that this is correct
                if self.round_to_magnitude {
                    round_to_order_of_magnitude(bet_amount)

                } else {
                    bet_amount
                }
            };

            // Scales it so that when it has more match data it bets higher, and when it has less match data it bets lower
            let bet_amount = if self.scale_by_matches {
                bet_amount * normalize(simulation.min_matches_len(left, right, tier), MINIMUM_MATCHES_MATCHMAKING - 1.0, MAXIMUM_MATCHES_MATCHMAKING)

            } else {
                bet_amount
            };

            let bet_amount = if let Some(minimum) = self.scale_by_time {
                range_inclusive(simulation.get_hourly_ratio(date), minimum, 1.0) * bet_amount

            } else {
                bet_amount
            };

            // TODO is this necessary ?
            let bet_amount = if self.scale_by_money {
                bet_amount.min(current_money * MAXIMUM_BET_PERCENTAGE)

            } else {
                bet_amount
            };

            /*if current_money > MINIMUM_BET_AMOUNT / MAXIMUM_BET_PERCENTAGE && bet_amount < MINIMUM_BET_AMOUNT {
                0.0

            } else {*/
                self.apply_matchmaking_maximum(bet_amount)
            //}
        }
    }
}

impl Permutate for CustomStrategy {
    fn each<F>(mut f: F) where F: FnMut(Self) {
        Permutate::each(|average_sums| {
            Permutate::each(|scale_by_matches| {
                Permutate::each(|round_to_magnitude| {
                    Permutate::each(|scale_by_money| {
                        Permutate::each(|money| {
                            Permutate::each(|bet| {
                                f(Self { average_sums, scale_by_matches, round_to_magnitude, scale_by_money, scale_by_time: None, money, bet });
                            });
                        });
                    });
                });
            });
        });
    }
}

impl Strategy for CustomStrategy {
    fn bet_amount<A: Simulator>(&self, simulation: &A, tier: &Tier, left: &str, right: &str, date: f64) -> (f64, f64) {
        let (left_bet, right_bet) = self.money.bet_amount(simulation, left, right, *tier, self.average_sums);

        // TODO are these needed ?
        let left_bet = left_bet.max(0.0);
        let right_bet = right_bet.max(0.0);

        //let left_bet = left_bet.min(MAXIMUM_BET_AMOUNT);
        //let right_bet = right_bet.min(MAXIMUM_BET_AMOUNT);

        (
            simulation.clamp(self.modify_bet_amount(simulation, left, right, *tier, date, left_bet)),
            simulation.clamp(self.modify_bet_amount(simulation, left, right, *tier, date, right_bet)),
        )
    }

    fn bet<A: Simulator>(&self, simulation: &A, tier: &Tier, left: &str, right: &str, date: f64) -> Bet {
        let (left_bet, right_bet) = self.bet_amount(simulation, tier, left, right, date);

        assert_not_nan(left_bet);
        assert_not_nan(right_bet);

        // TODO add in a bias so that it will prefer Left unless Right is much greater than Left
        let (left_value, right_value) = self.bet.bet_value(simulation, tier, left, right, left_bet, right_bet, date, self.average_sums);

        assert_not_nan(left_value);
        assert_not_nan(right_value);

        // TODO is this a good idea ?
        /*if left_bet <= 1.0 && right_bet > 1.0 {
            Bet::Right(right_bet)

        // TODO is this a good idea ?
        } else if right_bet <= 1.0 && left_bet > 1.0 {
            Bet::Left(left_bet)

        } else {*/
            if left_value > right_value {
                Bet::Left(left_bet)

            } else if right_value > left_value {
                Bet::Right(right_bet)

            } else {
                Bet::Left(1.0)
            }
        //}
    }
}


#[derive(Debug, Clone, Copy)]
pub struct AllInStrategy;

impl Strategy for AllInStrategy {
    fn bet_amount<A: Simulator>(&self, simulation: &A, _tier: &Tier, _left: &str, _right: &str, _date: f64) -> (f64, f64) {
        let bet_amount = simulation.current_money();
        (bet_amount, bet_amount)
    }

    // TODO use ELO instead of winrate
    fn bet<A: Simulator>(&self, simulation: &A, tier: &Tier, left: &str, right: &str, date: f64) -> Bet {
        // TODO a tiny bit hacky
        let bet_amount = self.bet_amount(simulation, tier, left, right, date).0;

        let (left_winrate, right_winrate) = winrates(simulation, left, right, *tier);

        assert_not_nan(left_winrate);
        assert_not_nan(right_winrate);

        let diff = (left_winrate - right_winrate).abs();

        // TODO should this be moved into the bet_amount method ?
        let bet_amount = if simulation.is_in_mines() {
            bet_amount

        } else if diff < MINIMUM_WINRATE {
            0.0

        } else {
            bet_amount
        };

        // Bet $1 for maximum exp
        let bet_amount = bet_amount.max(1.0);

        //let diff = (left_winrate - right_winrate).abs();

        /*if !simulation.is_in_mines() {
            bet_amount = bet_amount * normalize(diff, 0.0, 0.50);
        }*/

        if left_winrate > right_winrate {
            Bet::Left(bet_amount)

        } else if right_winrate > left_winrate {
            Bet::Right(bet_amount)

        } else {
            Bet::Left(bet_amount)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::{Record, Tier};
    use crate::simulation::{Elo, Simulator};

    struct TestSimulator {
        current_money: f64,
        in_mines: bool,
        min_matches: f64,
        left_elo: Elo,
        right_elo: Elo,
        records: Vec<Record>,
    }

    impl TestSimulator {
        fn new(current_money: f64, in_mines: bool, min_matches: f64) -> Self {
            Self {
                current_money,
                in_mines,
                min_matches,
                left_elo: elo(5.0),
                right_elo: elo(-5.0),
                records: vec![],
            }
        }
    }

    fn elo(value: f64) -> Elo {
        let rating = glicko2::Glicko2Rating {
            value,
            deviation: 1.0,
            volatility: 0.06,
        };
        Elo {
            wins: rating,
            upsets: rating,
        }
    }

    impl Simulator for TestSimulator {
        fn get_hourly_ratio(&self, _date: f64) -> f64 {
            1.0
        }

        fn elo(&self, name: &str, _tier: Tier) -> Elo {
            if name == "Left" {
                self.left_elo
            } else {
                self.right_elo
            }
        }

        fn average_sum(&self) -> f64 {
            self.current_money
        }

        fn clamp(&self, bet_amount: f64) -> f64 {
            bet_amount
        }

        fn matches_len(&self, _name: &str, _tier: Tier) -> usize {
            self.min_matches as usize
        }

        fn min_matches_len(&self, _left: &str, _right: &str, _tier: Tier) -> f64 {
            self.min_matches
        }

        fn current_money(&self) -> f64 {
            self.current_money
        }

        fn is_in_mines(&self) -> bool {
            self.in_mines
        }

        fn lookup_character(&self, _name: &str, _tier: Tier) -> Vec<&Record> {
            self.records.iter().collect()
        }

        fn lookup_specific_character(&self, _left: &str, _right: &str, _tier: Tier) -> Vec<&Record> {
            vec![]
        }
    }

    fn amount(strategy: &CustomStrategy, simulation: &TestSimulator) -> (f64, f64) {
        strategy.bet_amount(simulation, &Tier::A, "Left", "Right", 0.0)
    }

    #[test]
    fn matchmaking_factory_preserves_the_existing_default_strategy() {
        assert_eq!(matchmaking_strategy(FIXED_BET_AMOUNT), MATCHMAKING_STRATEGY);
    }

    #[test]
    fn configured_max_bet_is_the_input_to_confidence_scaling() {
        let simulation = TestSimulator::new(10_000_000.0, false, 50.0);
        let lower = amount(&matchmaking_strategy(32_000.0), &simulation).0;
        let higher = amount(&matchmaking_strategy(64_000.0), &simulation).0;

        assert!(lower > 0.0);
        assert!((higher - (lower * 2.0)).abs() < 1e-9);
    }

    #[test]
    fn match_history_and_balance_scaling_still_reduce_matchmaking_bets() {
        let high_history = TestSimulator::new(1_000_000.0, false, 50.0);
        let low_history = TestSimulator::new(1_000_000.0, false, 5.0);
        let strategy = matchmaking_strategy(100_000.0);

        let high_history_amount = amount(&strategy, &high_history).0;
        let low_history_amount = amount(&strategy, &low_history).0;

        assert!((high_history_amount - 15_000.0).abs() < 1e-9);
        assert!(low_history_amount < high_history_amount);
    }

    #[test]
    fn configured_maximum_caps_low_balance_recovery_above_the_mines() {
        let simulation = TestSimulator::new(100_000.0, false, 50.0);
        let (left, right) = amount(&matchmaking_strategy(1_000.0), &simulation);

        assert_eq!(left, 1_000.0);
        assert_eq!(right, 1_000.0);
    }

    #[test]
    fn mine_balance_remains_all_in_even_when_maximum_is_lower() {
        let simulation = TestSimulator::new(4_100.0, true, 50.0);
        let (left, right) = amount(&matchmaking_strategy(1_000.0), &simulation);

        assert_eq!(left, 4_100.0);
        assert_eq!(right, 4_100.0);
    }

    #[test]
    fn tournament_strategy_keeps_its_existing_formula() {
        let simulation = TestSimulator::new(100_000.0, false, 50.0);
        let (left, right) = amount(&TOURNAMENT_STRATEGY, &simulation);

        assert_eq!(left, 25_000.0);
        assert_eq!(right, 25_000.0);
    }
}
